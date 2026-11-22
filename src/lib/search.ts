import "server-only";
import { pool } from "./db";
import { toPgVector } from "./embeddings";
import type { Extraccion } from "./extraction-schema";
import { ollamaEmbed } from "./ollama";

const MIN_SIMILITUD = 0.2; // por debajo, el fragmento casi nunca tiene que ver con la pregunta
const MAX_FRAGMENTOS = 5; // con num_ctx 4096: ~5 × 300 tokens de contexto + pregunta + respuesta

export type Fuente = {
  /** Número con el que el modelo cita el documento: [1], [2]… */
  n: number;
  documentId: number;
  filename: string;
  tipo: Extraccion["tipo_documento"];
  resumen: string | null;
  datosClave: string | null;
  fragmentos: { chunkIndex: number; similitud: number; content: string }[];
};

/** Una línea con los datos que más se preguntan, para que el modelo no dependa solo del texto. */
export function datosClave(d: Extraccion): string | null {
  const partes: string[] = [];
  const add = (label: string, v: unknown) => {
    if (v != null && v !== "") partes.push(`${label}: ${v}`);
  };
  if (d.tipo_documento === "factura" && d.factura) {
    const f = d.factura;
    add("número", [f.serie, f.numero].filter(Boolean).join("-"));
    add("emisor", f.emisor.nombre);
    add("receptor", f.receptor.nombre);
    add("fecha de emisión", f.fecha_emision);
    add("vencimiento", f.fecha_vencimiento);
    add("subtotal", f.subtotal);
    add("total", f.total != null ? `${f.total} ${f.moneda ?? ""}`.trim() : null);
  } else if (d.tipo_documento === "recibo" && d.recibo) {
    const r = d.recibo;
    add("emisor", r.emisor.nombre);
    add("pagador", r.pagador.nombre);
    add("fecha", r.fecha);
    add("concepto", r.concepto);
    add("monto", r.monto != null ? `${r.monto} ${r.moneda ?? ""}`.trim() : null);
  } else if (d.tipo_documento === "contrato" && d.contrato) {
    const c = d.contrato;
    add("tipo", c.tipo_contrato);
    add("partes", c.partes.map((p) => `${p.nombre}${p.rol ? ` (${p.rol})` : ""}`).join(", "));
    add("firma", c.fecha_firma);
    add("vigencia", [c.fecha_inicio, c.fecha_fin].filter(Boolean).join(" a "));
    add("monto", c.monto != null ? `${c.monto} ${c.moneda ?? ""}`.trim() : null);
  }
  return partes.length ? partes.join("; ") : null;
}

/** Fuentes para los documentos que devolvió una consulta SQL (sin fragmentos de texto). */
export async function fuentesPorIds(ids: number[]): Promise<Fuente[]> {
  if (ids.length === 0) return [];
  const { rows } = await pool.query<{
    id: number;
    filename: string;
    tipo_documento: Extraccion["tipo_documento"];
    resumen: string | null;
    datos: Extraccion;
  }>(
    `SELECT id::int AS id, filename, tipo_documento, resumen, datos
       FROM documents WHERE id = ANY($1::bigint[])`,
    [ids],
  );
  const porId = new Map(rows.map((r) => [r.id, r]));
  // Mantiene el orden en que aparecen en el resultado; descarta ids que no existen
  return ids
    .filter((id) => porId.has(id))
    .map((id, i) => {
      const r = porId.get(id)!;
      return {
        n: i + 1,
        documentId: r.id,
        filename: r.filename,
        tipo: r.tipo_documento,
        resumen: r.resumen,
        datosClave: datosClave(r.datos),
        fragmentos: [],
      };
    });
}

/**
 * Busca los fragmentos más parecidos a la consulta (distancia coseno con pgvector)
 * y los agrupa por documento, numerando los documentos en orden de relevancia.
 */
export async function buscar(consulta: string): Promise<Fuente[]> {
  // Formato de consulta que recomienda embeddinggemma
  const [vector] = await ollamaEmbed([`task: search result | query: ${consulta}`]);

  const { rows } = await pool.query<{
    document_id: number;
    chunk_index: number;
    content: string;
    similitud: number;
    filename: string;
    tipo_documento: Extraccion["tipo_documento"];
    resumen: string | null;
    datos: Extraccion;
  }>(
    `SELECT k.document_id::int AS document_id, k.chunk_index, k.content,
            (1 - (k.embedding <=> $1::vector))::float8 AS similitud,
            d.filename, d.tipo_documento, d.resumen, d.datos
       FROM document_chunks k
       JOIN documents d ON d.id = k.document_id
      ORDER BY k.embedding <=> $1::vector
      LIMIT $2`,
    [toPgVector(vector), MAX_FRAGMENTOS],
  );

  const fuentes = new Map<number, Fuente>();
  for (const row of rows) {
    if (row.similitud < MIN_SIMILITUD) continue;
    let fuente = fuentes.get(row.document_id);
    if (!fuente) {
      fuente = {
        n: fuentes.size + 1,
        documentId: row.document_id,
        filename: row.filename,
        tipo: row.tipo_documento,
        resumen: row.resumen,
        datosClave: datosClave(row.datos),
        fragmentos: [],
      };
      fuentes.set(row.document_id, fuente);
    }
    fuente.fragmentos.push({
      chunkIndex: row.chunk_index,
      similitud: Math.round(row.similitud * 1000) / 1000,
      content: row.content,
    });
  }
  return [...fuentes.values()];
}
