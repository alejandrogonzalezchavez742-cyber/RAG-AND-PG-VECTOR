-- Esquema de Extracto. Idempotente: se puede ejecutar varias veces (npm run db:migrate).
CREATE EXTENSION IF NOT EXISTS vector;

-- Un documento subido y confirmado
CREATE TABLE IF NOT EXISTS documents (
  id              BIGSERIAL PRIMARY KEY,
  filename        TEXT        NOT NULL,
  mime_type       TEXT        NOT NULL,
  size_bytes      BIGINT      NOT NULL,
  archivo         BYTEA       NOT NULL,             -- archivo original, para poder volver a verlo
  tipo_documento  TEXT        NOT NULL CHECK (tipo_documento IN ('factura', 'recibo', 'contrato', 'otro')),
  confianza       TEXT        CHECK (confianza IN ('alta', 'media', 'baja')),
  resumen         TEXT,
  notas           TEXT,
  texto           TEXT,                             -- texto completo del documento (PDF u OCR del modelo)
  texto_origen    TEXT        CHECK (texto_origen IN ('pdf', 'modelo')),
  datos           JSONB       NOT NULL,             -- extracción completa tal como se confirmó
  modelo          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS documents_created_at_idx ON documents (created_at DESC);

-- ---------------------------------------------------------------- Facturas
CREATE TABLE IF NOT EXISTS facturas (
  document_id                BIGINT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  numero                     TEXT          NOT NULL,
  serie                      TEXT,
  fecha_emision              DATE          NOT NULL,
  fecha_vencimiento          DATE,
  emisor_nombre              TEXT          NOT NULL,
  emisor_id_fiscal           TEXT          NOT NULL,
  emisor_direccion           TEXT,
  receptor_nombre            TEXT          NOT NULL,
  receptor_id_fiscal         TEXT,
  receptor_direccion         TEXT,
  subtotal                   NUMERIC(14,2) NOT NULL,
  total                      NUMERIC(14,2) NOT NULL,
  moneda                     CHAR(3)       NOT NULL,
  forma_pago                 TEXT,
  folio_fiscal               TEXT
);

CREATE TABLE IF NOT EXISTS factura_conceptos (
  id               BIGSERIAL PRIMARY KEY,
  factura_id       BIGINT NOT NULL REFERENCES facturas(document_id) ON DELETE CASCADE,
  posicion         INT    NOT NULL,
  descripcion      TEXT   NOT NULL,
  cantidad         NUMERIC(14,4),
  precio_unitario  NUMERIC(14,4),
  importe          NUMERIC(14,2) NOT NULL,
  UNIQUE (factura_id, posicion)
);

CREATE TABLE IF NOT EXISTS factura_impuestos (
  id          BIGSERIAL PRIMARY KEY,
  factura_id  BIGINT NOT NULL REFERENCES facturas(document_id) ON DELETE CASCADE,
  posicion    INT    NOT NULL,
  tipo        TEXT   NOT NULL,
  tasa        NUMERIC(7,4),
  importe     NUMERIC(14,2) NOT NULL,
  es_retencion BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (factura_id, posicion)
);

-- ---------------------------------------------------------------- Recibos
CREATE TABLE IF NOT EXISTS recibos (
  document_id        BIGINT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  numero             TEXT,
  fecha              DATE          NOT NULL,
  emisor_nombre      TEXT          NOT NULL,
  emisor_id_fiscal   TEXT,
  emisor_direccion   TEXT,
  pagador_nombre     TEXT          NOT NULL,
  pagador_id_fiscal  TEXT,
  pagador_direccion  TEXT,
  concepto           TEXT          NOT NULL,
  monto              NUMERIC(14,2) NOT NULL,
  moneda             CHAR(3)       NOT NULL,
  metodo_pago        TEXT
);

-- ---------------------------------------------------------------- Contratos
CREATE TABLE IF NOT EXISTS contratos (
  document_id        BIGINT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  titulo             TEXT,
  tipo_contrato      TEXT NOT NULL,
  fecha_firma        DATE NOT NULL,
  fecha_inicio       DATE,
  fecha_fin          DATE,
  objeto             TEXT NOT NULL,
  monto              NUMERIC(14,2),
  moneda             CHAR(3),
  periodicidad_pago  TEXT,
  jurisdiccion       TEXT
);

CREATE TABLE IF NOT EXISTS contrato_partes (
  id              BIGSERIAL PRIMARY KEY,
  contrato_id     BIGINT NOT NULL REFERENCES contratos(document_id) ON DELETE CASCADE,
  posicion        INT    NOT NULL,
  nombre          TEXT   NOT NULL,
  rol             TEXT   NOT NULL,
  identificacion  TEXT,
  UNIQUE (contrato_id, posicion)
);

CREATE TABLE IF NOT EXISTS contrato_clausulas (
  id           BIGSERIAL PRIMARY KEY,
  contrato_id  BIGINT NOT NULL REFERENCES contratos(document_id) ON DELETE CASCADE,
  posicion     INT    NOT NULL,
  texto        TEXT   NOT NULL,
  UNIQUE (contrato_id, posicion)
);

-- ---------------------------------------------------------------- Embeddings
-- 768 dimensiones = embeddinggemma. Si cambias EMBED_MODEL a uno con otra dimensión,
-- cambia también este número (y vuelve a generar los embeddings).
CREATE TABLE IF NOT EXISTS document_chunks (
  id           BIGSERIAL PRIMARY KEY,
  document_id  BIGINT      NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index  INT         NOT NULL,
  content      TEXT        NOT NULL,
  embedding    vector(768) NOT NULL,
  UNIQUE (document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS document_chunks_embedding_idx
  ON document_chunks USING hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------- Consultas del chat
-- El chat genera SQL con un modelo de lenguaje. Ese SQL se ejecuta con un rol que
-- solo puede LEER las tablas de datos: no ve el archivo original ni los embeddings,
-- y no puede modificar nada. (Contraseña solo para el entorno local de Docker.)

-- Vista sin la columna `archivo` (bytea) ni el texto completo
CREATE OR REPLACE VIEW documentos AS
  SELECT id, filename, tipo_documento, resumen, created_at FROM documents;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'extracto_lector') THEN
    CREATE ROLE extracto_lector LOGIN PASSWORD 'extracto_lector';
  END IF;
END $$;

ALTER ROLE extracto_lector SET default_transaction_read_only = on;
ALTER ROLE extracto_lector SET statement_timeout = '5s';
ALTER ROLE extracto_lector CONNECTION LIMIT 5;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM extracto_lector;
GRANT USAGE ON SCHEMA public TO extracto_lector;
GRANT SELECT ON documentos, facturas, factura_conceptos, factura_impuestos,
  recibos, contratos, contrato_partes, contrato_clausulas TO extracto_lector;
