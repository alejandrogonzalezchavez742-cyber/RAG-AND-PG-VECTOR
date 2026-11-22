import "server-only";
import type { PoolClient } from "pg";
import { pool } from "./db";
import { toPgVector } from "./embeddings";
import type { Extraccion } from "./extraction-schema";
import { esRetencion, type Factura } from "./schemas/factura";
import type { Contrato } from "./schemas/contrato";
import type { Recibo } from "./schemas/recibo";

export type NuevoDocumento = {
  filename: string;
  mimeType: string;
  archivo: Buffer;
  datos: Extraccion;
  texto: string | null;
  textoOrigen: "pdf" | "modelo" | null;
  modelo: string | null;
  chunks: { content: string; embedding: number[] }[];
};

async function insertFactura(db: PoolClient, id: number, f: Factura) {
  await db.query(
    `INSERT INTO facturas (document_id, numero, serie, fecha_emision, fecha_vencimiento,
       emisor_nombre, emisor_id_fiscal, emisor_direccion,
       receptor_nombre, receptor_id_fiscal, receptor_direccion,
       subtotal, total, moneda, forma_pago, folio_fiscal)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      id, f.numero, f.serie, f.fecha_emision, f.fecha_vencimiento,
      f.emisor.nombre, f.emisor.identificacion_fiscal, f.emisor.direccion,
      f.receptor.nombre, f.receptor.identificacion_fiscal, f.receptor.direccion,
      f.subtotal, f.total, f.moneda, f.forma_pago, f.folio_fiscal,
    ],
  );
  for (const [i, c] of f.conceptos.entries()) {
    await db.query(
      `INSERT INTO factura_conceptos (factura_id, posicion, descripcion, cantidad, precio_unitario, importe)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, i + 1, c.descripcion, c.cantidad, c.precio_unitario, c.importe],
    );
  }
  for (const [i, t] of f.impuestos.entries()) {
    await db.query(
      `INSERT INTO factura_impuestos (factura_id, posicion, tipo, tasa, importe, es_retencion)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, i + 1, t.tipo, t.tasa, t.importe, esRetencion(t.tipo)],
    );
  }
}

async function insertRecibo(db: PoolClient, id: number, r: Recibo) {
  await db.query(
    `INSERT INTO recibos (document_id, numero, fecha,
       emisor_nombre, emisor_id_fiscal, emisor_direccion,
       pagador_nombre, pagador_id_fiscal, pagador_direccion,
       concepto, monto, moneda, metodo_pago)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      id, r.numero, r.fecha,
      r.emisor.nombre, r.emisor.identificacion_fiscal, r.emisor.direccion,
      r.pagador.nombre, r.pagador.identificacion_fiscal, r.pagador.direccion,
      r.concepto, r.monto, r.moneda, r.metodo_pago,
    ],
  );
}

async function insertContrato(db: PoolClient, id: number, c: Contrato) {
  await db.query(
    `INSERT INTO contratos (document_id, titulo, tipo_contrato, fecha_firma, fecha_inicio, fecha_fin,
       objeto, monto, moneda, periodicidad_pago, jurisdiccion)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      id, c.titulo, c.tipo_contrato, c.fecha_firma, c.fecha_inicio, c.fecha_fin,
      c.objeto, c.monto, c.moneda, c.periodicidad_pago, c.jurisdiccion,
    ],
  );
  for (const [i, p] of c.partes.entries()) {
    await db.query(
      `INSERT INTO contrato_partes (contrato_id, posicion, nombre, rol, identificacion)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, i + 1, p.nombre, p.rol, p.identificacion],
    );
  }
  for (const [i, texto] of c.clausulas_clave.entries()) {
    await db.query(
      `INSERT INTO contrato_clausulas (contrato_id, posicion, texto) VALUES ($1,$2,$3)`,
      [id, i + 1, texto],
    );
  }
}

/** Guarda documento, datos estructurados y embeddings en una sola transacción. */
export async function guardarDocumento(doc: NuevoDocumento): Promise<number> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const { datos } = doc;
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO documents (filename, mime_type, size_bytes, archivo, tipo_documento, confianza,
         resumen, notas, texto, texto_origen, datos, modelo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id`,
      [
        doc.filename, doc.mimeType, doc.archivo.length, doc.archivo,
        datos.tipo_documento, datos.confianza, datos.resumen, datos.notas,
        doc.texto, doc.textoOrigen, JSON.stringify(datos), doc.modelo,
      ],
    );
    const id = Number(rows[0].id);

    if (datos.tipo_documento === "factura" && datos.factura) await insertFactura(db, id, datos.factura);
    if (datos.tipo_documento === "recibo" && datos.recibo) await insertRecibo(db, id, datos.recibo);
    if (datos.tipo_documento === "contrato" && datos.contrato) await insertContrato(db, id, datos.contrato);

    for (const [i, chunk] of doc.chunks.entries()) {
      await db.query(
        `INSERT INTO document_chunks (document_id, chunk_index, content, embedding)
         VALUES ($1,$2,$3,$4::vector)`,
        [id, i, chunk.content, toPgVector(chunk.embedding)],
      );
    }

    await db.query("COMMIT");
    return id;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}

export type DocumentoGuardado = {
  id: number;
  filename: string;
  mime_type: string;
  tipo_documento: Extraccion["tipo_documento"];
  resumen: string | null;
  contraparte: string | null;
  fecha: string | null;
  importe: string | null; // NUMERIC llega como texto para no perder precisión
  moneda: string | null;
  fragmentos: number;
  created_at: string;
};

export async function listarDocumentos(limit = 100): Promise<DocumentoGuardado[]> {
  const { rows } = await pool.query<DocumentoGuardado>(
    `SELECT d.id::int AS id, d.filename, d.mime_type, d.tipo_documento, d.resumen,
            COALESCE(f.emisor_nombre, r.emisor_nombre,
              (SELECT p.nombre FROM contrato_partes p WHERE p.contrato_id = d.id ORDER BY p.posicion LIMIT 1)
            ) AS contraparte,
            COALESCE(f.fecha_emision, r.fecha, c.fecha_firma)::text AS fecha,
            COALESCE(f.total, r.monto, c.monto)::text AS importe,
            COALESCE(f.moneda, r.moneda, c.moneda) AS moneda,
            (SELECT count(*) FROM document_chunks k WHERE k.document_id = d.id)::int AS fragmentos,
            d.created_at
       FROM documents d
       LEFT JOIN facturas f  ON f.document_id = d.id
       LEFT JOIN recibos r   ON r.document_id = d.id
       LEFT JOIN contratos c ON c.document_id = d.id
      ORDER BY d.created_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function obtenerArchivo(id: number) {
  const { rows } = await pool.query<{ filename: string; mime_type: string; archivo: Buffer }>(
    `SELECT filename, mime_type, archivo FROM documents WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}
