import { z } from "zod";
import { CHAT_MODEL, OllamaError, ollamaChat } from "@/lib/ollama";
import { buscar, fuentesPorIds, type Fuente } from "@/lib/search";
import { ESQUEMA_SQL, SqlError, ejecutarSql, idsDeFila, type ResultadoSql } from "@/lib/sql-query";

const NUM_CTX = 4096;
const HISTORIAL = 4; // mensajes previos (2 turnos) que se envían para entender preguntas de seguimiento
const MAX_HISTORIAL_CHARS = 600;
const FILAS_AL_MODELO = 30; // el resto se ve en la tabla de la interfaz

const Body = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().trim().min(1).max(2000),
      }),
    )
    .min(1)
    .max(50)
    .refine((m) => m.at(-1)?.role === "user", "El último mensaje debe ser del usuario"),
});

// ---------------------------------------------------------------- Router + SQL

const Plan = z.object({
  modo: z.enum(["sql", "busqueda"]),
  sql: z.string().nullable(),
});
const PLAN_FORMAT = z.toJSONSchema(Plan);

const PLAN_SYSTEM = (hoy: string) => `Decides cómo responder preguntas sobre documentos guardados (facturas, recibos, contratos).

modo "sql": la pregunta pide un CÁLCULO o un dato agregado: totales, sumas, cuántos, promedios, máximos o mínimos, rankings, comparaciones entre documentos, o listas filtradas por fecha, importe, proveedor o tipo. Escribe en "sql" una consulta PostgreSQL.
modo "busqueda": cualquier otra pregunta (qué dice un documento, cláusulas, descripciones, condiciones). "sql" va en null.

Tablas disponibles (no existe ninguna otra):
${ESQUEMA_SQL}

Reglas del SQL:
- Una sola sentencia SELECT (o WITH … SELECT). Nada de INSERT, UPDATE, DELETE ni DDL. Sin comentarios.
- Para buscar nombres o textos usa ILIKE con comodines, p. ej. emisor_nombre ILIKE '%papeler%'.
- Al sumar importes agrupa por moneda y devuelve la moneda.
- Incluye SIEMPRE los documentos de origen: en consultas agregadas añade array_agg(DISTINCT <tabla>.document_id) AS documentos; en listados, la columna document_id.
- Hoy es ${hoy}. Usa CURRENT_DATE y date_trunc / EXTRACT para periodos ("este mes", "este año").
- Para un total general NO agrupes por documento; agrupa solo por moneda. No uses funciones de ventana (OVER).
- Limita los listados con LIMIT 50.

Ejemplos:
P: ¿Cuánto suman todas mis facturas?
SQL: SELECT moneda, SUM(total) AS total, COUNT(*) AS facturas, array_agg(document_id) AS documentos FROM facturas GROUP BY moneda
P: ¿Cuánto he pagado a cada proveedor este año?
SQL: SELECT emisor_nombre, moneda, SUM(total) AS total, array_agg(document_id) AS documentos FROM facturas WHERE fecha_emision >= date_trunc('year', CURRENT_DATE) GROUP BY emisor_nombre, moneda ORDER BY total DESC LIMIT 50
P: ¿Cuánto IVA pagué a Acme?
SQL: SELECT f.moneda, SUM(i.importe) AS iva, COUNT(DISTINCT f.document_id) AS facturas, array_agg(DISTINCT f.document_id) AS documentos FROM facturas f JOIN factura_impuestos i ON i.factura_id = f.document_id WHERE i.tipo ILIKE '%iva%' AND NOT i.es_retencion AND f.emisor_nombre ILIKE '%acme%' GROUP BY f.moneda
P: ¿Qué contratos terminan en los próximos 90 días?
SQL: SELECT document_id, titulo, tipo_contrato, fecha_fin FROM contratos WHERE fecha_fin BETWEEN CURRENT_DATE AND CURRENT_DATE + 90 ORDER BY fecha_fin LIMIT 50`;

const ANSWER_SQL_SYSTEM = `Respondes preguntas sobre los documentos del usuario a partir del RESULTADO de una consulta SQL que ya se ejecutó.
Reglas:
1. Usa SOLO las cifras del resultado. No recalcules ni inventes datos.
2. Cada fila trae en "citar" los documentos de origen, p. ej. "[1][2]". Copia esas citas después de cada dato que uses. Si "citar" está vacío, no pongas ninguna cita con número.
3. Solo si el resultado tiene 0 filas, di que no hay documentos guardados que cumplan la condición.
4. Responde en español, breve y directo. Importes con su moneda.`;

const ANSWER_RAG_SYSTEM = `Eres un asistente que responde preguntas sobre los documentos del usuario (facturas, recibos y contratos).
Reglas:
1. Usa SOLO la información de los documentos que se te dan en el mensaje. No uses conocimiento externo.
2. Cada documento lleva un número entre corchetes, p. ej. [1]. Después de cada dato o afirmación, cita el documento del que sale con ese número: [1], o [1][2] si sale de varios.
3. Si los documentos no contienen la respuesta, dilo claramente ("No lo encuentro en los documentos guardados") y no inventes nada.
4. Responde en español, de forma breve y directa. Importes con su moneda.`;

type Historial = { role: "user" | "assistant"; content: string }[];

async function planificar(pregunta: string, historial: Historial, signal: AbortSignal, errorPrevio?: { sql: string; error: string }) {
  const hoy = new Date().toISOString().slice(0, 10);
  let content = `Pregunta: ${pregunta}`;
  if (errorPrevio) {
    content += `\n\nTu consulta anterior no sirvió:\n${errorPrevio.sql}\nProblema: ${errorPrevio.error}\nCorrígela usando solo las tablas y columnas indicadas.`;
  }
  const r = await ollamaChat({
    model: CHAT_MODEL,
    format: PLAN_FORMAT,
    numCtx: NUM_CTX,
    numPredict: 400,
    timeoutMs: 5 * 60 * 1000,
    signal,
    messages: [{ role: "system", content: PLAN_SYSTEM(hoy) }, ...historial, { role: "user", content }],
  });
  let raw: unknown = null;
  try {
    raw = JSON.parse(r.content);
  } catch {
    // respuesta cortada o no JSON: se trata como búsqueda semántica
  }
  const plan = Plan.safeParse(raw);
  if (!plan.success) return { modo: "busqueda" as const, sql: null };
  return plan.data;
}

/** Intenta responder con SQL: genera, ejecuta y, si Postgres lo rechaza, pide una corrección. */
async function viaSql(
  pregunta: string,
  sqlInicial: string,
  historial: Historial,
  signal: AbortSignal,
): Promise<{ resultado: ResultadoSql } | { fallo: string; sql: string }> {
  const INTENTOS = 2;
  let sql = sqlInicial;
  for (let intento = 1; intento <= INTENTOS; intento++) {
    let problema: string;
    try {
      const resultado = await ejecutarSql(sql);
      // Sin ids de documento no se pueden citar las fuentes: se pide una corrección
      const sinFuentes = resultado.filas.length > 0 && resultado.filas.every((f) => idsDeFila(f).length === 0);
      if (!sinFuentes || intento === INTENTOS) return { resultado };
      problema =
        "Al resultado le faltan los documentos de origen. Añade array_agg(DISTINCT <tabla>.document_id) AS documentos (consultas agregadas) o la columna document_id (listados).";
    } catch (error) {
      if (!(error instanceof SqlError)) throw error;
      if (intento === INTENTOS) return { fallo: error.message, sql };
      problema = error.message;
    }
    console.warn(`SQL a corregir (intento ${intento}): ${problema}\n${sql}`);
    const plan = await planificar(pregunta, historial, signal, { sql, error: problema });
    if (plan.modo !== "sql" || !plan.sql) return { fallo: problema, sql };
    sql = plan.sql;
  }
  return { fallo: "No se pudo generar una consulta válida.", sql };
}

/** Numera los documentos del resultado y añade a cada fila la columna "citar" con sus citas. */
async function citarResultado(resultado: ResultadoSql) {
  const idsPorFila = resultado.filas.map(idsDeFila);
  const fuentes = await fuentesPorIds([...new Set(idsPorFila.flat())]);
  const nPorId = new Map(fuentes.map((f) => [f.documentId, f.n]));
  const filas = resultado.filas.slice(0, FILAS_AL_MODELO).map((fila, i) => {
    const citas = [...new Set(idsPorFila[i].map((id) => nPorId.get(id)).filter(Boolean))];
    return { ...fila, citar: citas.map((n) => `[${n}]`).join("") };
  });
  return { fuentes, filas };
}

// ---------------------------------------------------------------- Búsqueda semántica

function contexto(fuentes: Fuente[]): string {
  return fuentes
    .map((f) => {
      const cabecera = [`[${f.n}] ${f.filename} (${f.tipo})`, f.resumen, f.datosClave && `Datos: ${f.datosClave}`]
        .filter(Boolean)
        .join("\n");
      const texto = f.fragmentos.map((x) => x.content).join("\n…\n");
      return `${cabecera}\nTexto:\n${texto}`;
    })
    .join("\n\n---\n\n");
}

// ---------------------------------------------------------------- Ruta

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Petición no válida." }, { status: 400 });
  }
  const { messages } = parsed.data;
  const pregunta = messages[messages.length - 1].content;
  const previa = messages.slice(0, -1).findLast((m) => m.role === "user")?.content;
  const historial: Historial = messages.slice(-1 - HISTORIAL, -1).map((m) => ({
    role: m.role,
    content: m.content.slice(0, MAX_HISTORIAL_CHARS),
  }));
  const signal = request.signal;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      const responder = (system: string, content: string) =>
        ollamaChat({
          model: CHAT_MODEL,
          numCtx: NUM_CTX,
          numPredict: 700,
          timeoutMs: 10 * 60 * 1000,
          signal,
          onDelta: (text) => send({ type: "delta", text }),
          messages: [{ role: "system", content: system }, ...historial, { role: "user", content }],
        });

      try {
        // 1. ¿Cálculo (SQL) o búsqueda semántica?
        const plan = await planificar(pregunta, historial, signal);

        if (plan.modo === "sql" && plan.sql) {
          const r = await viaSql(pregunta, plan.sql, historial, signal);
          if ("resultado" in r) {
            const { resultado } = r;
            const { fuentes, filas } = await citarResultado(resultado);
            send({ type: "mode", mode: "sql" });
            send({ type: "sources", sources: fuentes });
            send({
              type: "sql",
              sql: resultado.sql,
              columns: resultado.columnas,
              rows: resultado.filas,
              truncated: resultado.truncado,
            });
            // Sin columna de documentos, "citar" no aporta nada y confunde al modelo
            const conCitas = filas.some((f) => f.citar);
            const filasModelo = conCitas
              ? filas
              : filas.map((f) => Object.fromEntries(Object.entries(f).filter(([k]) => k !== "citar")));
            const datos =
              filas.length === 0
                ? "0 filas: ningún documento cumple la condición."
                : `${resultado.filas.length} ${resultado.filas.length === 1 ? "fila" : "filas"}` +
                  (resultado.filas.length > FILAS_AL_MODELO ? ` (se muestran ${FILAS_AL_MODELO})` : "") +
                  `:\n${JSON.stringify(filasModelo)}` +
                  (conCitas ? "" : "\n(Este resultado no indica los documentos de origen: no pongas citas con número.)");
            await responder(ANSWER_SQL_SYSTEM, `Consulta ejecutada:\n${resultado.sql}\n\nResultado:\n${datos}\n\nPregunta: ${pregunta}`);
            send({ type: "done" });
            return;
          }
          // El SQL falló dos veces: se avisa y se sigue con búsqueda semántica
          send({ type: "sql_error", sql: r.sql, message: r.fallo });
        }

        // 2. Búsqueda semántica sobre los embeddings
        send({ type: "mode", mode: "busqueda" });
        // La pregunta anterior ayuda a recuperar contexto en seguimientos ("¿y su fecha?")
        const fuentes = await buscar(previa ? `${previa}\n${pregunta}` : pregunta);
        send({ type: "sources", sources: fuentes });

        if (fuentes.length === 0) {
          send({
            type: "delta",
            text: "No encontré nada relacionado en los documentos guardados. Prueba a reformular la pregunta o guarda primero el documento.",
          });
          send({ type: "done" });
          return;
        }

        await responder(ANSWER_RAG_SYSTEM, `Documentos:\n\n${contexto(fuentes)}\n\nPregunta: ${pregunta}`);
        send({ type: "done" });
      } catch (error) {
        if (signal.aborted) return;
        console.error(error);
        send({
          type: "error",
          message: error instanceof OllamaError ? error.message : "Error inesperado al responder.",
        });
      } finally {
        try {
          controller.close();
        } catch {
          // ya cerrado porque el cliente se fue
        }
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}
