@AGENTS.md

# Extracto

App de una sola página para subir facturas, recibos y contratos (imagen o PDF), extraer sus datos con un modelo de visión **local** (Ollama), revisarlos en un formulario validado, guardarlos en PostgreSQL + pgvector y hacer preguntas sobre ellos en un chat que cita el documento de origen. Todo corre en local: ningún documento sale del equipo.

Stack: Next.js 16 (App Router, `cacheComponents: true`), React 19, TypeScript, Tailwind 4, Zod 4, `pg`, pdf.js, Ollama, PostgreSQL 17 + pgvector nativo de Windows (sin Docker). UI, prompts y mensajes en español.

## Arrancar

```bash
npm run db:migrate          # aplica db/schema.sql (idempotente) a extracto_app
npm run dev                 # http://localhost:3000
```

La base es `extracto_app` en el PostgreSQL 17 nativo de Windows (servicio `postgresql-x64-17`, puerto **5432**, pgvector 0.8.7 ya instalado en su carpeta `lib`/`share\extension`). Arranca sola con Windows. Su creación (rol `extracto`, base, `CREATE EXTENSION vector`) está en el README. `docker-compose.yml` queda solo como alternativa (puerto 5442).

Requiere Ollama abierto con `qwen3-vl:4b-instruct` y `embeddinggemma` descargados (`ollama pull …`). Variables en `.env.local` (plantilla en `.env.example`): `DATABASE_URL`, `DATABASE_URL_LECTOR`, `OLLAMA_URL`, `OLLAMA_MODEL`, `EMBED_MODEL`, `CHAT_MODEL` (opcional).

Comprobar cambios: `npx tsc --noEmit`, `npm run lint`, `npm run build`. No hay tests automáticos.

Documentos de prueba ficticios en `ejemplos/` (contrato y recibo en PDF, con su HTML de origen).

## Flujo y archivos

1. **Subida y preparación (navegador)** — `src/components/UploadPreview.tsx`, `src/lib/prepare-document.ts`. Las imágenes se reescalan a JPEG de 1280 px. Los PDF se renderizan con pdf.js: solo la **primera página** como imagen, más la capa de texto de hasta 50 páginas.
2. **Extracción** — `POST /api/extract` (`src/app/api/extract/route.ts`). Envía la imagen y hasta 4000 caracteres de texto al modelo de visión con salida estructurada (`format` = JSON Schema de `Extraccion`) y valida la respuesta con Zod.
3. **Revisión** — `src/components/DocumentForm.tsx` (formulario editable por tipo) y `src/lib/validation.ts`. Los campos inválidos se muestran en rojo y se revalidan con cada cambio.
4. **Guardado** — `POST /api/documents` (`src/app/api/documents/route.ts`, `src/lib/documents.ts`). Vuelve a validar en servidor. Si no hay texto (imágenes, PDF escaneados), el modelo de visión transcribe la página 1. El texto se trocea (~1000 caracteres, solape de 150; `src/lib/embeddings.ts`) y se generan embeddings. Todo se escribe en **una transacción**: `documents` (archivo original en `bytea` + extracción en JSONB) + tabla del tipo + `document_chunks`.
5. **Lista** — `GET /api/documents`, `src/components/SavedDocuments.tsx`. `GET /api/documents/[id]/file` sirve el original.
6. **Chat** — `POST /api/chat` (`src/app/api/chat/route.ts`, `src/components/Chat.tsx`). Una llamada al modelo decide el modo:
   - **`sql`** para cálculos y totales: el modelo escribe SQL (`src/lib/sql-query.ts`), se ejecuta con el rol de solo lectura y se responde con el resultado.
   - **`busqueda`** para todo lo demás: RAG con pgvector (`src/lib/search.ts`, top 5 por coseno, similitud ≥ 0,2).
   - La respuesta llega en streaming NDJSON (`mode`, `sources`, `sql`/`sql_error`, `delta`, `done`/`error`). Las citas `[n]` remiten a documentos numerados por el servidor.

Ollama se llama siempre a través de `src/lib/ollama.ts` (`ollamaChat`, `ollamaEmbed`, `OllamaError` con mensaje y código HTTP ya pensados para el usuario).

## Esquemas Zod (`src/lib/schemas/`)

Cada tipo (`factura.ts`, `recibo.ts`, `contrato.ts`) define tres esquemas:

- `*Extraido`/`*Extraida`: forma permisiva (todo `nullable`) que rellena el modelo. `src/lib/extraction-schema.ts` los compone en `Extraccion`, que es también el JSON Schema que recibe Ollama. **Cambiar su forma cambia la salida del modelo y las columnas que se guardan.**
- `*Schema`: campos obligatorios y formatos (fechas `AAAA-MM-DD` reales, moneda ISO de 3 letras, importes ≥ 0).
- `*Reglas`: reglas entre campos (subtotal + impuestos = total con tolerancia de 0,01 y retenciones restando; orden de fechas).

`validarDocumento` ejecuta `*Schema` y `*Reglas` **por separado** y fusiona los errores con rutas tipo `factura.emisor.nombre`. Motivo: en Zod 4 un `superRefine` no se ejecuta si algún campo del objeto falla, así que con un solo esquema el error del total no aparecería hasta corregir todo lo demás. Por lo mismo, un `.refine` sobre un array se ejecuta aunque falle `.min(1)`: no indexes el array sin comprobarlo (usa `.at(-1)?.`).

## Base de datos (`db/schema.sql`)

- `documents`; `facturas` + `factura_conceptos` + `factura_impuestos`; `recibos`; `contratos` + `contrato_partes` + `contrato_clausulas`; `document_chunks` con `embedding vector(768)` e índice HNSW. Todas cuelgan de `documents` con `ON DELETE CASCADE`.
- `vector(768)` está ligado a `embeddinggemma`. Cambiar `EMBED_MODEL` a otra dimensión obliga a cambiar la columna y regenerar los embeddings.
- `embeddinggemma` usa prefijos: `title: none | text: …` para documentos y `task: search result | query: …` para consultas. Sin ellos la búsqueda empeora.
- `src/lib/db.ts` lee `DATE` como texto (evita desfases de zona horaria). `NUMERIC` llega como string: no lo conviertas a número para guardar.
- `vector` no es una extensión *trusted*: la crea el superusuario `postgres`. El `CREATE EXTENSION IF NOT EXISTS` de `schema.sql` solo es un no-op si ya existe.
- En el mismo Postgres 17 hay una base `extracto` de **otro proyecto (Django)**: no es la de esta app, no la toques.
- `pg_dump` de versiones más nuevas emite `\restrict`/`\unrestrict`, que el psql 17.5 local no entiende: quita esas líneas antes de restaurar.

## Seguridad del SQL generado

El SQL del chat lo escribe un modelo. **Ejecútalo solo con `readerPool`** (rol `extracto_lector`, `DATABASE_URL_LECTOR`), nunca con `pool`: el usuario principal `extracto` es dueño de las tablas (tiene `CREATEROLE`, aunque no es superusuario).
- Ojo: el `pg_hba.conf` local está en `trust` para localhost, así que las contraseñas no se comprueban. La protección del rol lector son sus permisos, no su contraseña.

- El rol solo tiene `SELECT` sobre la vista `documentos` (sin `archivo` ni `texto`) y las tablas de datos. No ve `documents` ni `document_chunks`.
- `default_transaction_read_only = on`, `statement_timeout = 5s`.
- `ejecutarSql` añade otra barrera: rechaza todo lo que no sea una única sentencia `SELECT`/`WITH` sin comentarios, la ejecuta en `BEGIN TRANSACTION READ ONLY` y la envuelve en `SELECT * FROM (…) LIMIT 201`.
- Si añades una tabla que el chat deba consultar: dale `GRANT SELECT` en `schema.sql` y descríbela en `ESQUEMA_SQL`.
- Para citar, el SQL debe devolver `document_id` o `array_agg(document_id) AS documentos` (`idsDeFila`). Si falta, se pide una corrección al modelo (máximo 2 intentos y luego búsqueda semántica). Los ejemplos de consultas del prompt (`PLAN_SYSTEM`) son los que hacen que un modelo de 4B escriba SQL válido: no los quites.

## Restricciones del modelo local (aprendidas probando)

Equipo de desarrollo: RTX 2050 de 4 GB y 16 GB de RAM.

- **Usa variantes `-instruct`.** `qwen3-vl:4b` es la variante *thinking*: incluso con `think: false` gasta todos los tokens razonando y devuelve `content` vacío. Comprueba con `ollama show <modelo>` que no aparezca `thinking` en Capabilities.
- **`num_ctx: 4096`**: con 16k el modelo no cabe en la GPU (68 % en CPU) y una extracción tardó más de 9 minutos. Todo debe caber en 4096 tokens: imagen de 1280 px ≈ 1100 + texto ≤ 4000 caracteres ≈ 1150 + instrucciones + respuesta. Si no cabe, Ollama **recorta la entrada sin avisar**. Por eso se envía 1 sola página como imagen.
- **Siempre en streaming.** El `fetch` de Node (undici) corta a los 5 min si no llegan cabeceras (`headersTimeout`), aunque el `AbortSignal` propio sea mayor.
- **`num_predict` acotado** (1536 en extracción) y detección de bucles: los modelos pequeños pueden quedarse emitiendo espacios hasta llenar el contexto. `ollamaChat` corta tras 200 caracteres en blanco seguidos.
- Las preguntas de texto del chat tardan unos 4–15 s. La extracción con imagen tarda minutos.

## Next.js 16

- Lee `node_modules/next/dist/docs/` antes de usar una API (ver `AGENTS.md`).
- Con `cacheComponents` no se puede exportar `runtime` en una ruta (error de compilación); Node ya es el valor por defecto.
- Los `GET` de las rutas se prerenderizan si no tocan datos dinámicos: `GET /api/documents` llama a `connection()` para ejecutarse siempre en cada petición.
- Parámetros dinámicos: `ctx: RouteContext<"/api/documents/[id]/file">` y `await ctx.params`.

## Entorno Windows

- Postgres nativo: 17 en el 5432 (el de la app), 16 en el 5433 y 18 en el 5434. Binarios en `C:\Program Files\PostgreSQL\17\bin` (`psql`, `pg_dump`). El contenedor Docker opcional usa el **5442**.
- `ollama` puede no estar en el `PATH` de la terminal hasta abrir una nueva: `%LOCALAPPDATA%\Programs\Ollama\ollama.exe`.
- Para PDFs de prueba nuevos: escribe el HTML y conviértelo con Edge en modo headless (`msedge --headless=new --no-pdf-header-footer --print-to-pdf=…`).
