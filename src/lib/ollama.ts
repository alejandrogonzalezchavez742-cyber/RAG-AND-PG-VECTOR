import "server-only";

export const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
export const VISION_MODEL = process.env.OLLAMA_MODEL ?? "qwen3-vl:4b-instruct";
export const EMBED_MODEL = process.env.EMBED_MODEL ?? "embeddinggemma";
// Para el chat basta un modelo de texto; por defecto se reutiliza el de visión (ya está en memoria).
export const CHAT_MODEL = process.env.CHAT_MODEL ?? VISION_MODEL;

/** Error ya traducido para el usuario, con el código HTTP que debe devolver la ruta. */
export class OllamaError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string; images?: string[] };

export type ChatResult = {
  content: string;
  thinkingChars: number;
  doneReason: string | null;
  /** El modelo se quedó emitiendo solo espacios/saltos de línea y se cortó. */
  degenerate: boolean;
  promptTokens: number | null;
  totalDurationMs: number | null;
};

async function post(path: string, body: unknown, timeoutMs: number, model: string, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${OLLAMA_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (signal?.aborted) throw error; // el cliente se fue: no hay a quién responder
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new OllamaError("El modelo local tardó demasiado en responder.", 504);
    }
    throw new OllamaError(`No se pudo conectar con Ollama en ${OLLAMA_URL}. ¿Está abierto Ollama?`, 503);
  }
  if (res.ok) return res;

  const detail = await res.json().catch(() => null);
  if (res.status === 404) {
    throw new OllamaError(`El modelo ${model} no está descargado. Ejecuta: ollama pull ${model}`, 503);
  }
  const message = typeof detail?.error === "string" ? detail.error : `HTTP ${res.status}`;
  throw new OllamaError(`Ollama devolvió un error: ${message}`, 502);
}

/**
 * Chat en streaming. Se usa streaming porque el fetch de Node corta a los 5 min si
 * no llegan las cabeceras (headersTimeout de undici), y un modelo local puede tardar más.
 */
export async function ollamaChat(opts: {
  model?: string;
  messages: ChatMessage[];
  format?: unknown;
  numCtx: number;
  numPredict: number;
  timeoutMs: number;
  /** Se llama con cada trozo de texto según llega. */
  onDelta?: (text: string) => void;
  /** Cancela la generación (p. ej. si el navegador cierra la petición). */
  signal?: AbortSignal;
}): Promise<ChatResult> {
  const model = opts.model ?? VISION_MODEL;
  const res = await post(
    "/api/chat",
    {
      model,
      stream: true,
      think: false,
      format: opts.format,
      options: { temperature: 0, num_ctx: opts.numCtx, num_predict: opts.numPredict },
      messages: opts.messages,
    },
    opts.timeoutMs,
    model,
    opts.signal,
  );

  const result: ChatResult = {
    content: "",
    thinkingChars: 0,
    doneReason: null,
    degenerate: false,
    promptTokens: null,
    totalDurationMs: null,
  };

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const chunk = JSON.parse(line);
        if (chunk.error) throw new OllamaError(`Ollama devolvió un error: ${chunk.error}`, 502);
        if (typeof chunk.message?.content === "string" && chunk.message.content) {
          result.content += chunk.message.content;
          opts.onDelta?.(chunk.message.content);
        }
        if (typeof chunk.message?.thinking === "string") result.thinkingChars += chunk.message.thinking.length;
        if (chunk.done) {
          result.doneReason = chunk.done_reason ?? null;
          result.promptTokens = chunk.prompt_eval_count ?? null;
          result.totalDurationMs =
            typeof chunk.total_duration === "number" ? Math.round(chunk.total_duration / 1e6) : null;
        }
      }
      // Modelo atascado emitiendo espacios/saltos de línea: corta en vez de esperar minutos
      if (result.content.length >= 200 && result.content.slice(-200).trim() === "") {
        result.degenerate = true;
        await reader.cancel();
        break;
      }
    }
  } catch (error) {
    if (error instanceof OllamaError || opts.signal?.aborted) throw error;
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new OllamaError("El modelo local tardó demasiado en responder.", 504);
    }
    throw new OllamaError("Se perdió la conexión con Ollama mientras respondía.", 502);
  }

  if (result.promptTokens != null && result.promptTokens >= opts.numCtx) {
    console.warn(`La entrada (${result.promptTokens} tokens) llenó el contexto de ${opts.numCtx}; Ollama pudo recortarla.`);
  }
  return result;
}

/** Embeddings de varios textos en una sola llamada. */
export async function ollamaEmbed(inputs: string[], model = EMBED_MODEL): Promise<number[][]> {
  if (inputs.length === 0) return [];
  const res = await post("/api/embed", { model, input: inputs }, 10 * 60 * 1000, model);
  const body = await res.json();
  if (!Array.isArray(body?.embeddings) || body.embeddings.length !== inputs.length) {
    throw new OllamaError("Ollama no devolvió los embeddings esperados.", 502);
  }
  return body.embeddings;
}
