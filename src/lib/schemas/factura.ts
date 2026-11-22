import { z } from "zod";
import {
  ParteExtraida,
  fecha,
  fechaAntes,
  fechaOpc,
  fechaReq,
  importeReq,
  moneda,
  monedaReq,
  numero,
  numeroOpc,
  redondear,
  texto,
  textoOpc,
  textoReq,
} from "./common";

/** Lo que devuelve el modelo: misma forma, todo puede venir en null. */
export const FacturaExtraida = z.object({
  numero: texto,
  serie: texto,
  fecha_emision: fecha,
  fecha_vencimiento: fecha,
  emisor: ParteExtraida,
  receptor: ParteExtraida,
  conceptos: z.array(
    z.object({
      descripcion: z.string(),
      cantidad: numero,
      precio_unitario: numero,
      importe: numero,
    }),
  ),
  subtotal: numero,
  impuestos: z.array(
    z.object({
      tipo: z.string().describe("IVA, ISR, retención, etc."),
      tasa: numero.describe("Porcentaje, p. ej. 16 para 16%"),
      importe: numero,
    }),
  ),
  total: numero,
  moneda,
  forma_pago: texto,
  folio_fiscal: texto.describe("UUID / CFDI u otro identificador fiscal"),
});
export type Factura = z.infer<typeof FacturaExtraida>;

/** Campos obligatorios y formato de cada campo. */
export const FacturaSchema = z.object({
  numero: textoReq,
  serie: textoOpc,
  fecha_emision: fechaReq,
  fecha_vencimiento: fechaOpc,
  emisor: z.object({
    nombre: textoReq,
    identificacion_fiscal: textoReq,
    direccion: textoOpc,
  }),
  receptor: z.object({
    nombre: textoReq,
    identificacion_fiscal: textoOpc,
    direccion: textoOpc,
  }),
  conceptos: z
    .array(
      z.object({
        descripcion: textoReq,
        cantidad: numeroOpc,
        precio_unitario: numeroOpc,
        importe: importeReq,
      }),
    )
    .min(1, "Debe haber al menos un concepto"),
  subtotal: importeReq,
  impuestos: z.array(
    z.object({
      tipo: textoReq,
      tasa: numeroOpc,
      importe: importeReq,
    }),
  ),
  total: importeReq,
  moneda: monedaReq,
  forma_pago: textoOpc,
  folio_fiscal: textoOpc,
});

/** Las retenciones (ISR/IVA retenido) se restan del total en lugar de sumarse. */
export const esRetencion = (tipo: string | null) => !!tipo && /reten/i.test(tipo);

/**
 * Reglas entre campos. Usa la forma permisiva para ejecutarse siempre, aunque
 * otros campos tengan errores (Zod no ejecuta refinamientos si el objeto falla).
 */
export const FacturaReglas = FacturaExtraida.superRefine((f, ctx) => {
  if (f.subtotal != null && f.total != null && f.impuestos.every((i) => i.importe != null)) {
    const impuestos = f.impuestos.reduce(
      (acc, i) => acc + (esRetencion(i.tipo) ? -1 : 1) * (i.importe ?? 0),
      0,
    );
    const esperado = redondear(f.subtotal + impuestos);
    if (Math.abs(esperado - f.total) > 0.01) {
      ctx.addIssue({
        code: "custom",
        path: ["total"],
        message: `Subtotal + impuestos = ${esperado.toFixed(2)}, no ${f.total.toFixed(2)}`,
      });
    }
  }

  if (fechaAntes(f.fecha_emision, f.fecha_vencimiento) === false) {
    ctx.addIssue({
      code: "custom",
      path: ["fecha_vencimiento"],
      message: "El vencimiento es anterior a la emisión",
    });
  }
});

export const facturaVacia = (): Factura => ({
  numero: null,
  serie: null,
  fecha_emision: null,
  fecha_vencimiento: null,
  emisor: { nombre: null, identificacion_fiscal: null, direccion: null },
  receptor: { nombre: null, identificacion_fiscal: null, direccion: null },
  conceptos: [],
  subtotal: null,
  impuestos: [],
  total: null,
  moneda: null,
  forma_pago: null,
  folio_fiscal: null,
});
