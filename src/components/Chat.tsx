"use client";

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";

type Fuente = {
  n: number;
  documentId: number;
  filename: string;
  tipo: string;
  resumen: string | null;
  fragmentos: { chunkIndex: number; similitud: number; content: string }[];
};

type ConsultaSql = {
  sql: string;
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
};

type Asistente = {
  role: "assistant";
  content: string;
  sources: Fuente[];
  pending: boolean;
  error?: string;
  mode?: "sql" | "busqueda";
  sql?: ConsultaSql;
  /** El SQL generado falló y se respondió con búsqueda semántica. */
  sqlError?: { sql: string; message: string };
};

type Mensaje = { role: "user"; content: string } | Asistente;

const SUGERENCIAS = [
  "¿Cuánto he pagado a cada proveedor?",
  "¿Cuántas facturas tengo y cuánto suman?",
  "¿Qué productos aparecen en mis facturas?",
];

const fileUrl = (f: Fuente) => `/api/documents/${f.documentId}/file`;

/** Convierte las citas [n] del texto en enlaces al documento de origen. */
function conCitas(texto: string, sources: Fuente[]): ReactNode[] {
  const porN = new Map(sources.map((s) => [s.n, s]));
  return texto.split(/(\[\d+\])/g).map((parte, i) => {
    const m = /^\[(\d+)\]$/.exec(parte);
    const fuente = m && porN.get(Number(m[1]));
    if (!fuente) return <Fragment key={i}>{parte}</Fragment>;
    return (
      <a
        key={i}
        href={fileUrl(fuente)}
        target="_blank"
        rel="noopener noreferrer"
        title={fuente.filename}
        className="mx-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded bg-indigo-100 px-1 align-text-top text-[11px] font-semibold text-indigo-700 no-underline hover:bg-indigo-200 dark:bg-indigo-950 dark:text-indigo-300"
      >
        {fuente.n}
      </a>
    );
  });
}

function citadas(texto: string, sources: Fuente[]): Fuente[] {
  const ns = new Set([...texto.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
  return sources.filter((s) => ns.has(s.n));
}

function Fuentes({ mensaje }: { mensaje: Asistente }) {
  if (mensaje.pending || mensaje.sources.length === 0) return null;
  const citas = citadas(mensaje.content, mensaje.sources);
  const lista = citas.length ? citas : mensaje.sources;
  return (
    <div className="mt-3 flex flex-col gap-1.5 border-t border-zinc-200 pt-3 dark:border-zinc-800">
      <p className="text-xs font-medium text-zinc-500">
        {citas.length
          ? "Fuentes"
          : mensaje.mode === "sql"
            ? "Documentos incluidos en el cálculo"
            : "Documentos consultados (la respuesta no citó ninguno)"}
      </p>
      {lista.map((f) => (
        <details key={f.n} className="group text-sm">
          <summary className="flex cursor-pointer list-none items-center gap-2">
            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded bg-indigo-100 px-1 text-[11px] font-semibold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
              {f.n}
            </span>
            <a
              href={fileUrl(f)}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate text-indigo-600 hover:underline dark:text-indigo-400"
              onClick={(e) => e.stopPropagation()}
            >
              {f.filename}
            </a>
            <span className="shrink-0 text-xs text-zinc-500">
              {f.tipo}
              {f.fragmentos.length > 0 && ` · similitud ${f.fragmentos[0].similitud.toFixed(2)}`}
            </span>
            {f.fragmentos.length > 0 && (
              <span className="ml-auto shrink-0 text-xs text-zinc-400 group-open:hidden">ver fragmento</span>
            )}
          </summary>
          {f.resumen && f.fragmentos.length === 0 && (
            <p className="mt-1 pl-7 text-xs text-zinc-500">{f.resumen}</p>
          )}
          {f.fragmentos.map((x) => (
            <blockquote
              key={x.chunkIndex}
              className="mt-2 whitespace-pre-wrap rounded-lg bg-zinc-50 p-3 text-xs leading-relaxed text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400"
            >
              {x.content}
            </blockquote>
          ))}
        </details>
      ))}
    </div>
  );
}

const celda = (v: unknown) =>
  v == null ? "—" : Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v);

/** Consulta SQL ejecutada y su resultado, para que el usuario pueda comprobar el cálculo. */
function DetalleSql({ mensaje }: { mensaje: Asistente }) {
  if (mensaje.sqlError) {
    return (
      <details className="mt-3 text-xs text-amber-700 dark:text-amber-400">
        <summary className="cursor-pointer">
          No se pudo calcular con SQL; se respondió con búsqueda semántica
        </summary>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-lg bg-zinc-50 p-3 font-mono text-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
          {mensaje.sqlError.sql}
        </pre>
        <p className="mt-1">{mensaje.sqlError.message}</p>
      </details>
    );
  }
  if (!mensaje.sql) return null;
  const { sql, columns, rows, truncated } = mensaje.sql;
  return (
    <details className="mt-3 text-xs">
      <summary className="cursor-pointer text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
        Ver consulta SQL y resultado ({rows.length}
        {truncated ? "+" : ""} {rows.length === 1 ? "fila" : "filas"})
      </summary>
      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-lg bg-zinc-950 p-3 font-mono text-zinc-100">
        {sql}
      </pre>
      {rows.length > 0 && (
        <div className="mt-2 max-h-64 overflow-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-left">
            <thead className="sticky top-0 bg-zinc-50 dark:bg-zinc-900">
              <tr>
                {columns.map((c) => (
                  <th key={c} className="px-3 py-1.5 font-medium text-zinc-500">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {rows.map((r, i) => (
                <tr key={i}>
                  {columns.map((c) => (
                    <td key={c} className="px-3 py-1.5 tabular-nums">
                      {celda(r[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {truncated && <p className="mt-1 text-zinc-500">Resultado recortado a las primeras filas.</p>}
    </details>
  );
}

export default function Chat() {
  const [mensajes, setMensajes] = useState<Mensaje[]>([]);
  const [input, setInput] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const enCurso = mensajes.at(-1)?.role === "assistant" && (mensajes.at(-1) as { pending: boolean }).pending;

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [mensajes]);

  const actualizarUltimo = (fn: (m: Asistente) => Mensaje) =>
    setMensajes((prev) => {
      const last = prev.at(-1);
      if (!last || last.role !== "assistant") return prev;
      return [...prev.slice(0, -1), fn(last)];
    });

  const enviar = async (texto: string) => {
    const pregunta = texto.trim();
    if (!pregunta || enCurso) return;

    // Solo se envía texto previo (sin fuentes) para que el modelo entienda seguimientos
    const historial = [
      ...mensajes.filter((m) => m.role === "user" || !m.error).map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: pregunta },
    ].filter((m) => m.content.trim());

    setInput("");
    setMensajes((prev) => [
      ...prev,
      { role: "user", content: pregunta },
      { role: "assistant", content: "", sources: [], pending: true },
    ]);

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: historial }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `Error ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line);
          if (ev.type === "mode") actualizarUltimo((m) => ({ ...m, mode: ev.mode }));
          else if (ev.type === "sql")
            actualizarUltimo((m) => ({
              ...m,
              sql: { sql: ev.sql, columns: ev.columns, rows: ev.rows, truncated: ev.truncated },
            }));
          else if (ev.type === "sql_error")
            actualizarUltimo((m) => ({ ...m, sqlError: { sql: ev.sql, message: ev.message } }));
          else if (ev.type === "sources") actualizarUltimo((m) => ({ ...m, sources: ev.sources }));
          else if (ev.type === "delta") actualizarUltimo((m) => ({ ...m, content: m.content + ev.text }));
          else if (ev.type === "error") throw new Error(ev.message);
        }
      }
      actualizarUltimo((m) => ({ ...m, pending: false }));
    } catch (err) {
      const message = controller.signal.aborted
        ? "Respuesta detenida."
        : err instanceof Error
          ? err.message
          : "Error desconocido";
      actualizarUltimo((m) => ({ ...m, pending: false, error: message }));
    }
  };

  return (
    <section className="flex flex-col gap-3" aria-labelledby="chat-titulo">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="chat-titulo" className="text-lg font-semibold">
          Preguntar a tus documentos
        </h2>
        {mensajes.length > 0 && !enCurso && (
          <button
            type="button"
            onClick={() => setMensajes([])}
            className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
          >
            Nueva conversación
          </button>
        )}
      </div>

      <div className="flex flex-col rounded-2xl border border-zinc-200 dark:border-zinc-800">
        <div className="flex max-h-[60vh] min-h-48 flex-col gap-4 overflow-y-auto p-4" aria-live="polite">
          {mensajes.length === 0 && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 py-6 text-center">
              <p className="text-sm text-zinc-500">
                Pregunta lo que quieras sobre los documentos guardados. Cada respuesta cita el documento de origen.
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {SUGERENCIAS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => enviar(s)}
                    className="rounded-full border border-zinc-300 px-3 py-1 text-sm text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {mensajes.map((m, i) =>
            m.role === "user" ? (
              <div
                key={i}
                className="max-w-[85%] self-end whitespace-pre-wrap rounded-2xl rounded-br-md bg-indigo-600 px-4 py-2 text-sm text-white"
              >
                {m.content}
              </div>
            ) : (
              <div
                key={i}
                className="max-w-[90%] self-start rounded-2xl rounded-bl-md bg-zinc-100 px-4 py-3 text-sm dark:bg-zinc-900"
              >
                {m.mode && (
                  <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
                    {m.mode === "sql" ? "Cálculo con SQL" : "Búsqueda semántica"}
                  </p>
                )}
                {m.pending && !m.content ? (
                  <span className="text-zinc-500">
                    {!m.mode
                      ? "Analizando la pregunta…"
                      : m.mode === "sql"
                        ? "Calculando…"
                        : m.sources.length
                          ? "Redactando la respuesta…"
                          : "Buscando en tus documentos…"}
                  </span>
                ) : (
                  <p className="whitespace-pre-wrap leading-relaxed">{conCitas(m.content, m.sources)}</p>
                )}
                {m.error && (
                  <p role="alert" className="mt-2 text-red-600 dark:text-red-400">
                    {m.error}
                  </p>
                )}
                {!m.pending && <DetalleSql mensaje={m} />}
                <Fuentes mensaje={m} />
              </div>
            ),
          )}
          <div ref={endRef} />
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            enviar(input);
          }}
          className="flex items-end gap-2 border-t border-zinc-200 p-3 dark:border-zinc-800"
        >
          <label htmlFor="chat-input" className="sr-only">
            Tu pregunta
          </label>
          <textarea
            id="chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                enviar(input);
              }
            }}
            rows={1}
            placeholder="Escribe una pregunta… (Enter para enviar, Mayús+Enter para salto de línea)"
            className="max-h-40 min-h-10 flex-1 resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 dark:border-zinc-700 dark:bg-zinc-900"
          />
          {enCurso ? (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="rounded-lg border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Detener
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-500 dark:disabled:bg-zinc-800"
            >
              Enviar
            </button>
          )}
        </form>
      </div>
    </section>
  );
}
