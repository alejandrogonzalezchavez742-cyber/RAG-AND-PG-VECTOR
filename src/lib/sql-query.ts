import "server-only";
import { readerPool } from "./db";

export const MAX_FILAS = 200;

/** Descripción de las tablas que puede consultar el modelo (las mismas que ve extracto_lector). */
export const ESQUEMA_SQL = `-- PostgreSQL. Importes NUMERIC(14,2); fechas DATE; moneda CHAR(3) (MXN, EUR, USD…).
documentos(id, filename, tipo_documento /* 'factura'|'recibo'|'contrato'|'otro' */, resumen, created_at /* cuándo se guardó */)
facturas(document_id → documentos.id, numero, serie, fecha_emision, fecha_vencimiento,
  emisor_nombre /* proveedor */, emisor_id_fiscal, emisor_direccion,
  receptor_nombre /* cliente */, receptor_id_fiscal, receptor_direccion,
  subtotal, total, moneda, forma_pago, folio_fiscal)
factura_conceptos(factura_id → facturas.document_id, posicion, descripcion, cantidad, precio_unitario, importe)
factura_impuestos(factura_id → facturas.document_id, posicion, tipo /* IVA, ISR… */, tasa /* % */, importe, es_retencion BOOLEAN)
recibos(document_id → documentos.id, numero, fecha, emisor_nombre /* quien cobra */, emisor_id_fiscal,
  pagador_nombre, pagador_id_fiscal, concepto, monto, moneda, metodo_pago)
contratos(document_id → documentos.id, titulo, tipo_contrato, fecha_firma, fecha_inicio, fecha_fin,
  objeto, monto, moneda, periodicidad_pago, jurisdiccion)
contrato_partes(contrato_id → contratos.document_id, posicion, nombre, rol, identificacion)
contrato_clausulas(contrato_id → contratos.document_id, posicion, texto)`;

export class SqlError extends Error {}

/**
 * Primera barrera (la segunda es el rol de solo lectura): una única sentencia
 * SELECT/WITH, sin comentarios que puedan esconder otra cosa.
 */
export function validarSql(sql: string): string {
  const limpio = sql.trim().replace(/;+\s*$/, "").trim();
  if (!limpio) throw new SqlError("La consulta está vacía.");
  if (limpio.includes(";")) throw new SqlError("Solo se permite una sentencia.");
  if (/--|\/\*/.test(limpio)) throw new SqlError("No se permiten comentarios en la consulta.");
  if (!/^(select|with)\b/i.test(limpio)) throw new SqlError("Solo se permiten consultas SELECT.");
  return limpio;
}

export type ResultadoSql = {
  sql: string;
  columnas: string[];
  filas: Record<string, unknown>[];
  truncado: boolean;
};

/** Ejecuta la consulta con el rol lector, en una transacción de solo lectura y con tiempo límite. */
export async function ejecutarSql(sql: string): Promise<ResultadoSql> {
  const limpio = validarSql(sql);
  const client = await readerPool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout = '5s'");
    // Envolver en subconsulta impide sentencias que no sean de lectura y limita el tamaño
    const res = await client.query(`SELECT * FROM (${limpio}) AS consulta LIMIT ${MAX_FILAS + 1}`);
    await client.query("ROLLBACK");
    const truncado = res.rows.length > MAX_FILAS;
    return {
      sql: limpio,
      columnas: res.fields.map((f) => f.name),
      filas: res.rows.slice(0, MAX_FILAS),
      truncado,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof SqlError) throw error;
    // Mensaje de Postgres: sirve para que el modelo corrija la consulta
    throw new SqlError(error instanceof Error ? error.message : String(error));
  } finally {
    client.release();
  }
}

/** Ids de documento que aparecen en una fila (columnas document_id / documentos / *_id). */
export function idsDeFila(fila: Record<string, unknown>): number[] {
  const ids: number[] = [];
  for (const [col, v] of Object.entries(fila)) {
    if (!/^(document_id|documentos|documento_ids?|factura_id|contrato_id|id)$/i.test(col)) continue;
    const valores = Array.isArray(v) ? v : [v];
    for (const x of valores) {
      const n = Number(x);
      if (Number.isSafeInteger(n) && n > 0) ids.push(n);
    }
  }
  return ids;
}
