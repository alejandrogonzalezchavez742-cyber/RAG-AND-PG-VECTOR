"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DocumentForm from "@/components/DocumentForm";
import SavedDocuments from "@/components/SavedDocuments";
import type { Extraccion } from "@/lib/extraction-schema";
import { prepareDocument, type PreparedDocument } from "@/lib/prepare-document";
import { validarDocumento } from "@/lib/validation";

const ACCEPTED_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/gif", "image/webp"];
const ACCEPT = ACCEPTED_TYPES.join(",");

type Preview = { file: File; url: string };

type Meta = { model: string; durationMs: number | null; textTruncated: boolean };

type Extraction =
  | { status: "idle" }
  | { status: "loading"; step: string }
  | { status: "error"; message: string }
  | { status: "done"; data: Extraccion; meta: Meta; prepared: PreparedDocument };

type Save =
  | { status: "idle" }
  | { status: "saving"; step: string }
  | { status: "saved"; id: number; fragmentos: number }
  | { status: "error"; message: string };

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function UploadPreview() {
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [extraction, setExtraction] = useState<Extraction>({ status: "idle" });
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const [save, setSave] = useState<Save>({ status: "idle" });
  const [listKey, setListKey] = useState(0);
  const saveRun = useRef(0); // descarta resultados de un guardado si ya se subió otro archivo

  const errores = useMemo(
    () => (extraction.status === "done" ? validarDocumento(extraction.data) : {}),
    [extraction],
  );
  const nErrores = Object.keys(errores).length;

  const updateDoc = (data: Extraccion) =>
    setExtraction((prev) => (prev.status === "done" ? { ...prev, data } : prev));

  // Libera la URL temporal cuando cambia o se desmonta
  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview.url);
    };
  }, [preview]);

  // Cancela una extracción en curso al desmontar
  useEffect(() => () => abortRef.current?.abort(), []);

  const extract = useCallback(async (file: File) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    saveRun.current++;
    setSave({ status: "idle" });
    setExtraction({ status: "loading", step: "Preparando el documento…" });

    try {
      const doc = await prepareDocument(file);
      if (controller.signal.aborted) return;

      const body = new FormData();
      doc.pages.forEach((page, i) => body.append("pages", page, `pagina-${i + 1}.jpg`));
      if (doc.text) body.append("text", doc.text);
      body.append("totalPages", String(doc.totalPages));

      setExtraction({
        status: "loading",
        step: "Analizando con el modelo local… (puede tardar un minuto)",
      });
      const res = await fetch("/api/extract", { method: "POST", body, signal: controller.signal });
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload?.data) {
        throw new Error(payload?.error ?? `Error ${res.status}`);
      }
      setExtraction({
        status: "done",
        data: payload.data,
        meta: {
          model: payload.model,
          durationMs: payload.durationMs,
          textTruncated: payload.textTruncated,
        },
        prepared: doc,
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      setExtraction({
        status: "error",
        message: err instanceof Error ? err.message : "Error desconocido",
      });
    }
  }, []);

  const handleFile = useCallback(
    (file: File | undefined) => {
      if (!file) return;
      if (!ACCEPTED_TYPES.includes(file.type)) {
        setError("Formato no soportado. Usa PDF, JPG, PNG, GIF o WEBP.");
        return;
      }
      setError(null);
      setCopied(false);
      setPreview({ file, url: URL.createObjectURL(file) });
      extract(file);
    },
    [extract],
  );

  const clear = () => {
    abortRef.current?.abort();
    saveRun.current++;
    setPreview(null);
    setExtraction({ status: "idle" });
    setSave({ status: "idle" });
    if (inputRef.current) inputRef.current.value = "";
  };

  const guardar = async () => {
    if (extraction.status !== "done" || !preview || nErrores > 0) return;
    const run = ++saveRun.current;
    const { prepared, data } = extraction;

    const body = new FormData();
    body.append("file", preview.file);
    body.append("data", JSON.stringify(data));
    if (prepared.text) body.append("text", prepared.text);
    else if (prepared.pages[0]) body.append("page", prepared.pages[0], "pagina-1.jpg");

    setSave({
      status: "saving",
      step: prepared.text
        ? "Guardando y generando embeddings…"
        : "Transcribiendo el texto con el modelo local y generando embeddings… (puede tardar unos minutos)",
    });
    try {
      const res = await fetch("/api/documents", { method: "POST", body });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error ?? `Error ${res.status}`);
      if (run !== saveRun.current) return;
      setSave({ status: "saved", id: payload.id, fragmentos: payload.fragmentos });
      setListKey((k) => k + 1);
    } catch (err) {
      if (run !== saveRun.current) return;
      setSave({ status: "error", message: err instanceof Error ? err.message : "Error desconocido" });
    }
  };

  const copyJson = async () => {
    if (extraction.status !== "done") return;
    await navigator.clipboard.writeText(JSON.stringify(extraction.data, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const isPdf = preview?.file.type === "application/pdf";

  return (
    <div className="flex w-full flex-col gap-6">
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          handleFile(e.dataTransfer.files[0]);
        }}
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
          dragging
            ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-950/40"
            : "border-zinc-300 hover:border-zinc-400 dark:border-zinc-700 dark:hover:border-zinc-500"
        }`}
      >
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          className="h-10 w-10 text-zinc-400"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
        </svg>
        <span className="font-medium">
          Arrastra un archivo aquí o{" "}
          <span className="text-indigo-600 dark:text-indigo-400">haz clic para elegir</span>
        </span>
        <span className="text-sm text-zinc-500">
          PDF o imagen JPG, PNG, GIF, WEBP · se procesa en tu equipo con Ollama
        </span>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="sr-only"
          onChange={(e) => handleFile(e.target.files?.[0])}
        />
      </label>

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      {preview && (
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="flex min-w-0 flex-col gap-3">
            <div className="flex min-h-[3.25rem] items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="truncate font-medium" title={preview.file.name}>
                  {preview.file.name}
                </p>
                <p className="text-sm text-zinc-500">
                  {isPdf ? "PDF" : preview.file.type} · {formatSize(preview.file.size)}
                </p>
              </div>
              <button
                type="button"
                onClick={clear}
                className="shrink-0 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                Quitar
              </button>
            </div>

            <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
              {isPdf ? (
                <iframe
                  src={preview.url}
                  title={`Vista previa de ${preview.file.name}`}
                  className="h-[70vh] w-full"
                />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={preview.url}
                  alt={`Vista previa de ${preview.file.name}`}
                  className="mx-auto max-h-[70vh] w-auto object-contain"
                />
              )}
            </div>
          </section>

          <section className="flex min-w-0 flex-col gap-3">
            <div className="flex min-h-[3.25rem] items-center justify-between gap-4">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-medium">Datos extraídos</h2>
                {extraction.status === "done" && (
                  <span
                    aria-live="polite"
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                      nErrores
                        ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
                        : "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                    }`}
                  >
                    {nErrores
                      ? `${nErrores} ${nErrores === 1 ? "campo por revisar" : "campos por revisar"}`
                      : "Todo válido"}
                  </span>
                )}
                {extraction.status === "done" && (
                  <span className="text-xs text-zinc-500">confianza {extraction.data.confianza}</span>
                )}
              </div>
              {extraction.status === "done" && (
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={() => setShowJson((v) => !v)}
                    aria-pressed={showJson}
                    className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  >
                    {showJson ? "Ver formulario" : "Ver JSON"}
                  </button>
                  <button
                    type="button"
                    onClick={copyJson}
                    className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  >
                    {copied ? "Copiado" : "Copiar JSON"}
                  </button>
                </div>
              )}
            </div>

            <div
              className={`h-[70vh] overflow-auto rounded-2xl border border-zinc-200 dark:border-zinc-800 ${
                extraction.status === "done" && !showJson ? "bg-white dark:bg-zinc-950" : "bg-zinc-950"
              }`}
            >
              {extraction.status === "loading" && (
                <div
                  role="status"
                  className="flex h-full flex-col items-center justify-center gap-3 text-sm text-zinc-400"
                >
                  <span className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-600 border-t-zinc-200" />
                  {extraction.step}
                </div>
              )}
              {extraction.status === "error" && (
                <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm">
                  <p role="alert" className="text-red-400">
                    {extraction.message}
                  </p>
                  <button
                    type="button"
                    onClick={() => extract(preview.file)}
                    className="rounded-lg border border-zinc-700 px-3 py-1.5 text-zinc-200 hover:bg-zinc-800"
                  >
                    Reintentar
                  </button>
                </div>
              )}
              {extraction.status === "done" &&
                (showJson ? (
                  <pre className="p-4 font-mono text-[13px] leading-relaxed text-zinc-100">
                    {JSON.stringify(extraction.data, null, 2)}
                  </pre>
                ) : (
                  <div className="p-4">
                    <DocumentForm doc={extraction.data} errores={errores} onChange={updateDoc} />
                  </div>
                ))}
            </div>
            {extraction.status === "done" && (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-zinc-500">
                  Modelo local: {extraction.meta.model}
                  {extraction.meta.durationMs != null &&
                    ` · ${(extraction.meta.durationMs / 1000).toFixed(1)} s`}
                  {extraction.meta.textTruncated &&
                    " · El texto del PDF era muy largo y se recortó para el modelo; los datos de las últimas páginas pueden faltar."}
                </p>
                <div className="flex items-center gap-3">
                  <span aria-live="polite" className="text-sm">
                    {save.status === "saving" && <span className="text-zinc-500">{save.step}</span>}
                    {save.status === "saved" && (
                      <span className="text-emerald-600 dark:text-emerald-400">
                        Guardado (#{save.id}, {save.fragmentos}{" "}
                        {save.fragmentos === 1 ? "fragmento" : "fragmentos"} con embedding)
                      </span>
                    )}
                    {save.status === "error" && (
                      <span role="alert" className="text-red-600">
                        {save.message}
                      </span>
                    )}
                    {save.status === "idle" && nErrores > 0 && (
                      <span className="text-zinc-500">Corrige los campos en rojo para guardar</span>
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={guardar}
                    disabled={nErrores > 0 || save.status === "saving" || save.status === "saved"}
                    className="shrink-0 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-500 dark:disabled:bg-zinc-800"
                  >
                    {save.status === "saving"
                      ? "Guardando…"
                      : save.status === "saved"
                        ? "Guardado"
                        : "Confirmar y guardar"}
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      <SavedDocuments refreshKey={listKey} />
    </div>
  );
}
