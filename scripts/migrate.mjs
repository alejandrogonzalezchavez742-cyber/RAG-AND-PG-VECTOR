// Aplica db/schema.sql a la base de DATABASE_URL. Uso: npm run db:migrate
import { readFile } from "node:fs/promises";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Falta DATABASE_URL (se lee de .env.local).");
  process.exit(1);
}

const sql = await readFile(new URL("../db/schema.sql", import.meta.url), "utf8");
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(sql);
  console.log("Esquema aplicado.");
} finally {
  await client.end();
}
