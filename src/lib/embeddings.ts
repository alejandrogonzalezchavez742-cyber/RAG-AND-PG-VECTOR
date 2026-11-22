import "server-only";
import { ollamaEmbed } from "./ollama";

const CHUNK_CHARS = 1000;
const OVERLAP_CHARS = 150;

/**
 * Divide el texto en fragmentos de ~1000 caracteres respetando párrafos y frases,
 * con un solape de ~150 caracteres para no partir una idea entre dos fragmentos.
 */
export function chunkText(text: string): string[] {
  const clean = text.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];

  // Piezas que no superan CHUNK_CHARS: párrafos, y si un párrafo es largo, sus frases
  const pieces: string[] = [];
  for (const para of clean.split(/\n\n/)) {
    if (para.length <= CHUNK_CHARS) {
      pieces.push(para);
      continue;
    }
    for (const sentence of para.split(/(?<=[.;:!?])\s+/)) {
      for (let i = 0; i < sentence.length; i += CHUNK_CHARS) pieces.push(sentence.slice(i, i + CHUNK_CHARS));
    }
  }

  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current && current.length + piece.length + 2 > CHUNK_CHARS) {
      chunks.push(current);
      current = current.slice(-OVERLAP_CHARS); // solape con el fragmento anterior
      const space = current.indexOf(" ");
      if (space > 0) current = current.slice(space + 1); // no empezar a mitad de palabra
    }
    current = current ? `${current}\n\n${piece}` : piece;
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

/** Embeddings de documento con el formato que recomienda embeddinggemma. */
export async function embedChunks(chunks: string[], title: string): Promise<number[][]> {
  const safeTitle = title.replace(/\s+/g, " ").trim() || "none";
  return ollamaEmbed(chunks.map((c) => `title: ${safeTitle} | text: ${c}`));
}

/** pgvector acepta el vector como texto "[0.1,0.2,…]". */
export const toPgVector = (v: number[]) => `[${v.join(",")}]`;
