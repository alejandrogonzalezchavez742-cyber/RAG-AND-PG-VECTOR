# Extracto

Next.js + PostgreSQL con pgvector. Una sola página para subir una imagen o un PDF y ver su vista previa.

## Arranque

La base de datos es el PostgreSQL 17 instalado en Windows (servicio `postgresql-x64-17`, puerto 5432), con pgvector 0.8.7 instalado. No hace falta Docker.

```bash
# 1. Base de datos: solo la primera vez, como superusuario postgres
psql -h localhost -p 5432 -U postgres -c "CREATE ROLE extracto LOGIN PASSWORD 'extracto' CREATEROLE" -c "CREATE DATABASE extracto_app OWNER extracto"
psql -h localhost -p 5432 -U postgres -d extracto_app -c "CREATE EXTENSION vector" -c "ALTER SCHEMA public OWNER TO extracto"

# 2. Variables de entorno
cp .env.example .env.local   # base extracto_app en el puerto 5432

# 3. App
npm install
npm run db:migrate   # aplica db/schema.sql (idempotente)
npm run dev
```

Abre http://localhost:3000.

## Estructura

- `src/app/page.tsx` — página principal
- `src/components/UploadPreview.tsx` — zona de arrastrar/soltar y vista previa (imagen o PDF)
- `src/lib/db.ts` — pool de conexión a Postgres (`DATABASE_URL`)
- `src/lib/documents.ts` — guardado en una transacción y lista de documentos
- `db/schema.sql` — tablas `documents`, `facturas`, `factura_conceptos`, `factura_impuestos`, `recibos`, `contratos`, `contrato_partes`, `contrato_clausulas` y `document_chunks` (`vector(768)` con índice HNSW)
- `docker-compose.yml` — alternativa opcional con Docker (imagen `pgvector/pgvector:pg17`, puerto 5442); si la usas, cambia el puerto y la base en `.env.local`

## Extracción con IA (local, con Ollama)

Al subir un archivo, el navegador lo convierte a imagen (los PDF con pdf.js, que también extrae su texto) y lo envía a `POST /api/extract`. La ruta llama a Ollama en local con el modelo de visión `qwen3-vl:4b-instruct` (la variante sin modo de razonamiento; la variante `qwen3-vl:4b` piensa antes de responder y gasta todo el contexto), que clasifica el documento como factura, recibo, contrato u otro y devuelve los datos en JSON según el esquema de `src/lib/extraction-schema.ts`. Nada sale de tu equipo.

- Requiere Ollama abierto y el modelo descargado: `ollama pull qwen3-vl:4b-instruct`.
- `OLLAMA_URL` y `OLLAMA_MODEL` se configuran en `.env.local`.
- Contexto de 4096 tokens: se envía 1 página como imagen (1280 px) y hasta 4000 caracteres de texto del PDF.
- Tiempo máximo por documento: 15 minutos.

## Guardado y embeddings

Al pulsar «Confirmar y guardar» (solo se activa si no hay campos en rojo), `POST /api/documents` vuelve a validar los datos y, en una sola transacción, guarda:

- el archivo original y la extracción completa (`documents`, columna `datos` en JSONB);
- los datos estructurados en la tabla de su tipo (`facturas` + conceptos + impuestos, `recibos`, o `contratos` + partes + cláusulas);
- el texto del documento dividido en fragmentos de ~1000 caracteres, cada uno con su embedding (`document_chunks`).

El texto sale de la capa de texto del PDF. Las imágenes y los PDF escaneados no tienen, así que el modelo de visión transcribe la primera página antes de guardar (tarda unos minutos).

Los embeddings se generan en local con `embeddinggemma` (768 dimensiones): `ollama pull embeddinggemma`. Si cambias `EMBED_MODEL` por uno de otra dimensión, cambia también `vector(768)` en `db/schema.sql`.

La lista «Documentos guardados» (`GET /api/documents`) aparece debajo; el nombre de cada archivo abre el original (`GET /api/documents/[id]/file`).

## Chat sobre los documentos

La sección «Preguntar a tus documentos» responde con búsqueda semántica (RAG) sobre los embeddings:

1. `POST /api/chat` convierte la pregunta en embedding (`embeddinggemma`) y busca en `document_chunks` los 5 fragmentos más parecidos por distancia coseno (`<=>` de pgvector). Se descartan los de similitud menor que 0,2.
2. Los fragmentos se agrupan por documento y se numeran `[1]`, `[2]`…; a cada documento se le añaden sus datos clave (emisor, fecha, total…).
3. El modelo local (`CHAT_MODEL`, por defecto el mismo que `OLLAMA_MODEL`) responde solo con esa información y cita el número del documento tras cada dato. Si no hay fragmentos relevantes, responde que no lo encuentra sin llamar al modelo.
4. La respuesta llega en streaming (NDJSON: primero las fuentes, luego el texto). En pantalla, cada `[n]` enlaza al archivo original y debajo se listan las fuentes con el fragmento usado.

Se envían los 2 turnos anteriores para entender preguntas de seguimiento. Solo se puede buscar en documentos que tengan texto (los guardados con al menos un fragmento).

### Preguntas de cálculo: SQL en lugar de embeddings

Antes de buscar, el modelo decide el modo. Si la pregunta pide un cálculo (totales, sumas, cuántos, promedios, rankings, filtros por fecha o importe) escribe una consulta PostgreSQL sobre las tablas de datos; si no, se usa la búsqueda semántica de arriba.

- El SQL se ejecuta con el rol **`extracto_lector`** (`DATABASE_URL_LECTOR`), creado en `db/schema.sql`: solo puede leer `documentos` (vista sin el archivo), `facturas`, `factura_conceptos`, `factura_impuestos`, `recibos`, `contratos`, `contrato_partes` y `contrato_clausulas`. No ve los archivos ni los embeddings y no puede modificar nada.
- Además, cada consulta corre en una transacción de solo lectura con límite de 5 s, dentro de una subconsulta con `LIMIT`, y se rechaza todo lo que no sea una única sentencia `SELECT`/`WITH` sin comentarios (`src/lib/sql-query.ts`).
- Si Postgres rechaza la consulta, o si al resultado le faltan los documentos de origen, se le devuelve el problema al modelo para que la corrija una vez. Si vuelve a fallar, se responde con búsqueda semántica y la interfaz lo indica.
- La consulta pide `array_agg(document_id) AS documentos`, así cada cifra se cita con el documento del que sale. En pantalla se puede desplegar la consulta SQL y su resultado para comprobar el cálculo.
