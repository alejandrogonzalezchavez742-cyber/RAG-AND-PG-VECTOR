// Se ejecuta en el navegador: convierte el archivo en imágenes JPEG que el modelo
// de visión local puede leer y, si es un PDF, extrae también su capa de texto.

const MAX_SIDE = 1280; // px; ≈1100 tokens de imagen, para caber en num_ctx 4096
const MAX_IMAGE_PAGES = 1; // con num_ctx 4096 solo cabe una página como imagen
const MAX_TEXT_PAGES = 50; // páginas de un PDF de las que se extrae texto

export type PreparedDocument = {
  pages: Blob[];
  text: string | null;
  totalPages: number;
};

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("No se pudo convertir la página a imagen."))),
      "image/jpeg",
      0.9,
    ),
  );
}

async function prepareImage(file: File): Promise<PreparedDocument> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("El navegador no pudo leer esta imagen.");
  });
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff"; // fondo blanco para PNG con transparencia
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return { pages: [await canvasToJpeg(canvas)], text: null, totalPages: 1 };
}

async function preparePdf(file: File): Promise<PreparedDocument> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();

  const task = pdfjs.getDocument({ data: await file.arrayBuffer() });
  const pdf = await task.promise;
  try {
    const pages: Blob[] = [];
    const texts: string[] = [];

    for (let n = 1; n <= Math.min(pdf.numPages, MAX_TEXT_PAGES); n++) {
      const page = await pdf.getPage(n);

      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : ""))
        .join("")
        .trim();
      if (pageText) texts.push(`--- Página ${n} ---\n${pageText}`);

      if (n <= MAX_IMAGE_PAGES) {
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: MAX_SIDE / Math.max(base.width, base.height) });
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        await page.render({ canvas, viewport }).promise;
        pages.push(await canvasToJpeg(canvas));
      }
      page.cleanup();
    }

    return { pages, text: texts.length ? texts.join("\n\n") : null, totalPages: pdf.numPages };
  } finally {
    await task.destroy();
  }
}

export function prepareDocument(file: File): Promise<PreparedDocument> {
  return file.type === "application/pdf" ? preparePdf(file) : prepareImage(file);
}
