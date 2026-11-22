"use client";

import { useEffect, useState } from "react";

type Documento = {
  id: number;
  filename: string;
  tipo_documento: "factura" | "recibo" | "contrato" | "otro";
  resumen: string | null;
  contraparte: string | null;
  fecha: string | null;
  importe: string | null;
  moneda: string | null;
  fragmentos: number;
  created_at: string;
};

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; documentos: Documento[] };

const TIPO: Record<Documento["tipo_documento"], { label: string; className: string }> = {
  factura: { label: "Factura", className: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300" },
  recibo: { label: "Recibo", className: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" },
  contrato: { label: "Contrato", className: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300" },
  otro: { label: "Otro", className: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" },
};

const fechaHora = new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "short" });

function formatImporte(importe: string | null, moneda: string | null) {
  if (importe == null) return "—";
  const n = Number(importe);
  try {
    return moneda
      ? new Intl.NumberFormat("es", { style: "currency", currency: moneda }).format(n)
      : n.toLocaleString("es", { minimumFractionDigits: 2 });
  } catch {
    return `${n.toFixed(2)} ${moneda ?? ""}`; // código de moneda que Intl no conoce
  }
}

export default function SavedDocuments({ refreshKey }: { refreshKey: number }) {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/documents", { signal: controller.signal, cache: "no-store" })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error ?? `Error ${res.status}`);
        setState({ status: "ready", documentos: body.documentos });
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setState({ status: "error", message: err instanceof Error ? err.message : "Error desconocido" });
      });
    return () => controller.abort();
  }, [refreshKey]);

  return (
    <section className="flex flex-col gap-3" aria-labelledby="guardados-titulo">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="guardados-titulo" className="text-lg font-semibold">
          Documentos guardados
        </h2>
        {state.status === "ready" && (
          <span className="text-sm text-zinc-500">
            {state.documentos.length} {state.documentos.length === 1 ? "documento" : "documentos"}
          </span>
        )}
      </div>

      {state.status === "loading" && <p className="text-sm text-zinc-500">Cargando…</p>}
      {state.status === "error" && (
        <p role="alert" className="text-sm text-red-600">
          {state.message}
        </p>
      )}
      {state.status === "ready" && state.documentos.length === 0 && (
        <p className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
          Aún no hay documentos. Sube uno, revisa los datos y pulsa «Confirmar y guardar».
        </p>
      )}
      {state.status === "ready" && state.documentos.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
              <tr>
                <th className="px-4 py-2.5 font-medium">Tipo</th>
                <th className="px-4 py-2.5 font-medium">Archivo</th>
                <th className="px-4 py-2.5 font-medium">Emisor / parte</th>
                <th className="px-4 py-2.5 font-medium">Fecha doc.</th>
                <th className="px-4 py-2.5 text-right font-medium">Importe</th>
                <th className="px-4 py-2.5 text-right font-medium" title="Fragmentos de texto con embedding">
                  Fragm.
                </th>
                <th className="px-4 py-2.5 font-medium">Guardado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {state.documentos.map((d) => (
                <tr key={d.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900/60">
                  <td className="px-4 py-2.5">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TIPO[d.tipo_documento].className}`}>
                      {TIPO[d.tipo_documento].label}
                    </span>
                  </td>
                  <td className="max-w-56 px-4 py-2.5">
                    <a
                      href={`/api/documents/${d.id}/file`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={d.resumen ?? d.filename}
                      className="block truncate text-indigo-600 hover:underline dark:text-indigo-400"
                    >
                      {d.filename}
                    </a>
                  </td>
                  <td className="max-w-56 truncate px-4 py-2.5" title={d.contraparte ?? undefined}>
                    {d.contraparte ?? "—"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 tabular-nums">{d.fecha ?? "—"}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums">
                    {formatImporte(d.importe, d.moneda)}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{d.fragmentos}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-zinc-500">
                    {fechaHora.format(new Date(d.created_at))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
