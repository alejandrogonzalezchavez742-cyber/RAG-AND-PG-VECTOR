import type { z } from "zod";
import type { Extraccion } from "./extraction-schema";
import { ContratoReglas, ContratoSchema } from "./schemas/contrato";
import { FacturaReglas, FacturaSchema } from "./schemas/factura";
import { ReciboReglas, ReciboSchema } from "./schemas/recibo";

/** Errores por ruta de campo, p. ej. "factura.emisor.nombre" → "Campo obligatorio". */
export type Errores = Record<string, string>;

const ESQUEMAS = {
  factura: [FacturaSchema, FacturaReglas],
  recibo: [ReciboSchema, ReciboReglas],
  contrato: [ContratoSchema, ContratoReglas],
} as const satisfies Record<string, readonly [z.ZodType, z.ZodType]>;

/**
 * Valida el documento del tipo seleccionado. Ejecuta por separado el esquema de
 * campos y el de reglas entre campos, para que ambos tipos de error se vean a la vez.
 */
export function validarDocumento(doc: Extraccion): Errores {
  const tipo = doc.tipo_documento;
  if (tipo === "otro") return {};

  const datos = doc[tipo];
  if (!datos) return { [tipo]: "Faltan los datos del documento" };

  const errores: Errores = {};
  for (const schema of ESQUEMAS[tipo]) {
    const result = schema.safeParse(datos);
    if (result.success) continue;
    for (const issue of result.error.issues) {
      const ruta = [tipo, ...issue.path.map(String)].join(".");
      errores[ruta] ??= issue.message; // el primer error de cada campo es el más útil
    }
  }
  return errores;
}
