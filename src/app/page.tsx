import Chat from "@/components/Chat";
import UploadPreview from "@/components/UploadPreview";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-8 px-6 py-16">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight">Extracto</h1>
        <p className="text-zinc-500">Sube una factura, un recibo o un contrato (imagen o PDF), revisa sus datos y pregunta sobre tus documentos guardados.</p>
      </header>
      <UploadPreview />
      <Chat />
    </main>
  );
}
