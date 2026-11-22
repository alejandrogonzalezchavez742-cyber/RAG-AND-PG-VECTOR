import { obtenerArchivo } from "@/lib/documents";

export async function GET(_req: Request, ctx: RouteContext<"/api/documents/[id]/file">) {
  const { id } = await ctx.params;
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) return new Response("Id no válido", { status: 400 });

  const doc = await obtenerArchivo(n);
  if (!doc) return new Response("Documento no encontrado", { status: 404 });

  return new Response(new Uint8Array(doc.archivo), {
    headers: {
      "Content-Type": doc.mime_type,
      // inline: el navegador lo muestra en lugar de descargarlo
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(doc.filename)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
