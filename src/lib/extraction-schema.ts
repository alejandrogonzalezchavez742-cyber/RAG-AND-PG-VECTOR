import { z } from "zod";
import { texto } from "./schemas/common";
import { ContratoExtraido } from "./schemas/contrato";
import { FacturaExtraida } from "./schemas/factura";
import { ReciboExtraido } from "./schemas/recibo";

/**
 * Esquema que se envía al modelo (formato de salida) y con el que se valida su
 * respuesta. Es permisivo: cualquier dato puede faltar. Las reglas de negocio
 * están en src/lib/validation.ts.
 */
export const Extraccion = z.object({
  tipo_documento: z.enum(["factura", "recibo", "contrato", "otro"]),
  confianza: z.enum(["alta", "media", "baja"]),
  resumen: z.string().describe("Una frase que describe el documento"),
  factura: FacturaExtraida.nullable(),
  recibo: ReciboExtraido.nullable(),
  contrato: ContratoExtraido.nullable(),
  notas: texto.describe("Campos ilegibles, ambigüedades u otras observaciones"),
});

export type Extraccion = z.infer<typeof Extraccion>;
export type TipoDocumento = Extraccion["tipo_documento"];
