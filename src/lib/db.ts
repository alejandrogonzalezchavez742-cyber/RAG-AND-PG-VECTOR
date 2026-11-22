import "server-only";
import { Pool, types } from "pg";

// DATE como texto "YYYY-MM-DD": convertirlo a Date lo desplazaría por la zona horaria.
types.setTypeParser(types.builtins.DATE, (v) => v);

const globalForDb = globalThis as unknown as { pool?: Pool; readerPool?: Pool };

export const pool =
  globalForDb.pool ??
  new Pool({ connectionString: process.env.DATABASE_URL });

/**
 * Conexión con el rol de solo lectura `extracto_lector` (ver db/schema.sql).
 * Es la ÚNICA que debe ejecutar SQL generado por el modelo.
 */
export const readerPool =
  globalForDb.readerPool ??
  new Pool({ connectionString: process.env.DATABASE_URL_LECTOR, max: 3 });

if (process.env.NODE_ENV !== "production") {
  globalForDb.pool = pool;
  globalForDb.readerPool = readerPool;
}
