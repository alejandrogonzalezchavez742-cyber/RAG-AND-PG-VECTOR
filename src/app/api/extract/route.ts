import { z } from "zod";
import { Extraccion } from "@/lib/extraction-schema";
import { OllamaError, VISION_MODEL, ollamaChat } from "@/lib/ollama";

// Con num_ctx 4096 todo (imagen + texto + respuesta JSON) debe caber en 4096 tokens;
// si no, Ollama recorta la entrada sin avisar. Presupuesto aproximado:
// imagen de 1280 px ≈ 1100, texto ≈ 1150, instrucciones ≈ 400, respuesta ≈ 1000-1400.
const NUM_CTX = 4096;
const MAX_PAGES = 1;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_CHARS = 4_000;
const TIMEOUT_MS = 15 * 60 * 1000; // un modelo local en una GPU de 4 GB puede tardar varios minutos

const OUTPUT_SCHEMA = z.toJSONSchema(Extraccion);

const SYSTEM = `Eres un sistema de extracción de datos de documentos.
Recibirás una o varias imágenes de un documento y, a veces, el texto extraído del PDF original.
Tu tarea:
1. Clasifícalo como "factura", "recibo", "contrato" u "otro".
2. Rellena SOLO el objeto correspondiente al tipo detectado; deja los otros dos en null. Si es "otro", los tres van en null.
3. Extrae únicamente lo que aparece en el documento. Si un dato no está o es ilegible, usa null; nunca lo inventes ni lo deduzcas.
4. Fechas en formato YYYY-MM-DD. Importes como números, sin símbolos ni separadores de miles. Moneda en código ISO 4217 (MXN, EUR, USD...) si se puede determinar.
5. Conserva nombres, números y textos tal como aparecen en el documento.
6. "confianza" refleja qué tan seguro estás de la clasificación y de la legibilidad general.
Responde solo con el JSON, compacto en una sola línea, sin sangría ni saltos de línea. No repitas elementos.`;

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "La petición debe ser multipart/form-data." }, 400);
  }

  const pages = form.getAll("pages").filter((v): v is File => v instanceof File);
  if (pages.length === 0) return json({ error: "No se recibió ninguna página." }, 400);
  if (pages.length > MAX_PAGES) return json({ error: `Máximo ${MAX_PAGES} páginas por petición.` }, 400);
  if (pages.some((p) => !["image/jpeg", "image/png"].includes(p.type) || p.size > MAX_PAGE_BYTES)) {
    return json({ error: "Las páginas deben ser JPEG o PNG de hasta 8 MB." }, 400);
  }

  const rawText = form.get("text");
  const totalPages = Number(form.get("totalPages")) || pages.length;
  let text = typeof rawText === "string" && rawText.trim() ? rawText : null;
  let textTruncated = false;
  if (text && text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS);
    textTruncated = true;
  }

  const images = await Promise.all(
    pages.map(async (p) => Buffer.from(await p.arrayBuffer()).toString("base64")),
  );

  let prompt = "Clasifica este documento y extrae sus datos.";
  if (totalPages > pages.length) {
    prompt += `\nEl documento tiene ${totalPages} páginas; se adjuntan como imagen las primeras ${pages.length}.`;
  }
  if (text) {
    prompt += `\n\nTexto extraído del PDF${textTruncated ? " (recortado por longitud)" : ""}:\n${text}`;
  }

  let r;
  try {
    r = await ollamaChat({
      format: OUTPUT_SCHEMA,
      numCtx: NUM_CTX,
      numPredict: 1536, // un JSON válido cabe de sobra en ~1500 tokens
      timeoutMs: TIMEOUT_MS,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: prompt, images },
      ],
    });
  } catch (error) {
    if (error instanceof OllamaError) return json({ error: error.message }, error.status);
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(r.content);
  } catch {
    parsed = null;
  }
  const result = Extraccion.safeParse(parsed);
  if (!result.success) {
    const cutOff = r.degenerate || r.doneReason === "length";
    const spentOnThinking = cutOff && r.content.trim() === "" && r.thinkingChars > 0;
    console.error(
      `Respuesta no válida del modelo (done_reason=${r.doneReason}, atascado=${r.degenerate}, ` +
        `prompt=${r.promptTokens} tokens, salida=${r.content.length} caracteres, ` +
        `razonamiento=${r.thinkingChars} caracteres). Final de la salida:\n` +
        JSON.stringify(r.content.slice(-800)),
    );
    if (!cutOff) console.error("Errores de validación:", result.error.issues.slice(0, 5));
    return json(
      {
        error: spentOnThinking
          ? `El modelo ${VISION_MODEL} gastó toda la respuesta razonando y no devolvió el JSON. Usa una variante "instruct" (p. ej. qwen3-vl:4b-instruct) en OLLAMA_MODEL.`
          : cutOff
            ? "El modelo local no terminó el JSON (se quedó repitiendo hasta llenar el contexto). Prueba con una imagen más nítida o con un modelo distinto."
            : "El modelo devolvió un JSON que no cumple el esquema. Intenta de nuevo.",
      },
      502,
    );
  }

  return json({
    data: result.data,
    model: VISION_MODEL,
    textTruncated,
    durationMs: r.totalDurationMs,
  });
}
