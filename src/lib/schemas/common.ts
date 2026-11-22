import { z } from "zod";

export const OBLIGATORIO = "Campo obligatorio";

/** true si `s` es YYYY-MM-DD y la fecha existe en el calendario (rechaza 2026-02-30). */
export function esFechaReal(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

// ---- Piezas para el esquema que rellena el modelo (todo puede ser null) ----

export const texto = z.string().nullable();
export const numero = z.number().nullable();
export const fecha = z.string().nullable().describe("Fecha en formato ISO YYYY-MM-DD, o null");
export const moneda = z.string().nullable().describe("Código ISO 4217, p. ej. MXN, EUR, USD");

export const ParteExtraida = z.object({
  nombre: texto,
  identificacion_fiscal: texto.describe("RFC, NIF, CIF, CUIT, etc."),
  direccion: texto,
});

// ---- Piezas para validar (lo que el usuario ve en rojo) ----

export const textoReq = z.string({ error: OBLIGATORIO }).trim().min(1, OBLIGATORIO);
export const textoOpc = z.string().nullable();

export const numeroReq = z.number({ error: OBLIGATORIO });
export const numeroOpc = z.number({ error: "Número inválido" }).nullable();
export const importeReq = numeroReq.nonnegative("No puede ser negativo");

const fechaBase = z
  .string({ error: OBLIGATORIO })
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Formato AAAA-MM-DD")
  .refine(esFechaReal, "La fecha no existe");
export const fechaReq = fechaBase;
export const fechaOpc = fechaBase.nullable();

export const monedaReq = z
  .string({ error: OBLIGATORIO })
  .regex(/^[A-Z]{3}$/, "Código ISO de 3 letras (MXN, EUR, USD…)");

/** Compara fechas YYYY-MM-DD válidas; si alguna falta o es inválida, no opina. */
export function fechaAntes(a: string | null, b: string | null): boolean | null {
  if (!a || !b || !esFechaReal(a) || !esFechaReal(b)) return null;
  return a <= b;
}

export const redondear = (n: number) => Math.round(n * 100) / 100;
