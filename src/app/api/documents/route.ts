import { connection } from "next/server";
import { guardarDocumento, listarDocumentos } from "@/lib/documents";
import { chunkText, embedChunks } from "@/lib/embeddings";
import { Extraccion } from "@/lib/extraction-schema";
import { OllamaError, VISION_MODEL, ollamaChat } from "@/lib/ollama";
import { validarDocumento } from "@/lib/validation";

const ACCEPTED_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/gif", "image/webp"];
const MAX_FILE_BYTES = 30 * 1024 * 1024;

const TRANSCRIBE_PROMPT = `Transcribe todo el texto visible de este documento, en orden de lectura.
Copia el texto tal cual, sin resumir, sin traducir y sin comentarios. Separa los bloques con una línea en blanco.`;

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

export async function GET() {
  await connection(); // siempre en tiempo de petición: la lista cambia al guardar
  try {
    return json({ documentos: await listarDocumentos() });
  } catch (error) {
    console.error(error);
    return json({ error: "No se pudo leer la base de datos. ¿Está iniciado el servicio postgresql-x64-17 y es correcto DATABASE_URL en .env.local?" }, 503);
  }
}

/** Imágenes y PDFs escaneados no tienen capa de texto: se la pide al modelo de visión. */
async function transcribir(page: File): Promise<string> {
  const image = Buffer.from(await page.arrayBuffer()).toString("base64");
  const r = await ollamaChat({
    numCtx: 4096, // imagen ≈ 1100 tokens + hasta 2560 de texto
    numPredict: 2560,
    timeoutMs: 15 * 60 * 1000,
    messages: [{ role: "user", content: TRANSCRIBE_PROMPT, images: [image] }],
  });
  if (r.doneReason === "length") console.warn("La transcripción llegó al límite de tokens y puede estar incompleta.");
  return r.content.trim();
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "La petición debe ser multipart/form-data." }, 400);
  }

  const file = form.get("file");
  if (!(file instanceof File)) return json({ error: "Falta el archivo original." }, 400);
  if (!ACCEPTED_TYPES.includes(file.type)) return json({ error: "Formato de archivo no soportado." }, 415);
  if (file.size > MAX_FILE_BYTES) return json({ error: "El archivo supera los 30 MB." }, 413);

  // Los datos se vuelven a validar aquí: el navegador no es de fiar
  let raw: unknown;
  try {
    raw = JSON.parse(String(form.get("data") ?? ""));
  } catch {
    return json({ error: "Los datos no son JSON válido." }, 400);
  }
  const parsed = Extraccion.safeParse(raw);
  if (!parsed.success) return json({ error: "Los datos no tienen la forma esperada." }, 400);
  const datos = parsed.data;
  const errores = validarDocumento(datos);
  if (Object.keys(errores).length > 0) {
    return json({ error: "Hay campos por corregir antes de guardar.", errores }, 422);
  }

  const rawText = form.get("text");
  const page = form.get("page");
  let texto = typeof rawText === "string" && rawText.trim() ? rawText.trim() : null;
  let textoOrigen: "pdf" | "modelo" | null = texto ? "pdf" : null;

  try {
    if (!texto && page instanceof File && page.size > 0) {
      texto = (await transcribir(page)) || null;
      textoOrigen = texto ? "modelo" : null;
    }

    const fragmentos = texto ? chunkText(texto) : [];
    const vectores = await embedChunks(fragmentos, "none");

    const id = await guardarDocumento({
      filename: file.name,
      mimeType: file.type,
      archivo: Buffer.from(await file.arrayBuffer()),
      datos,
      texto,
      textoOrigen,
      modelo: VISION_MODEL,
      chunks: fragmentos.map((content, i) => ({ content, embedding: vectores[i] })),
    });

    return json({ id, fragmentos: fragmentos.length, textoOrigen }, 201);
  } catch (error) {
    if (error instanceof OllamaError) return json({ error: error.message }, error.status);
    console.error(error);
    return json({ error: "No se pudo guardar en la base de datos. Revisa la consola del servidor." }, 500);
  }
}
