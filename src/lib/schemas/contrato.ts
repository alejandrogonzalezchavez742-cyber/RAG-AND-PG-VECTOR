import { z } from "zod";
import {
  fecha,
  fechaAntes,
  fechaOpc,
  fechaReq,
  moneda,
  monedaReq,
  numero,
  numeroOpc,
  texto,
  textoOpc,
  textoReq,
} from "./common";

export const ContratoExtraido = z.object({
  titulo: texto,
  tipo_contrato: texto.describe("Arrendamiento, servicios, compraventa, laboral, etc."),
  fecha_firma: fecha,
  fecha_inicio: fecha,
  fecha_fin: fecha,
  partes: z.array(
    z.object({
      nombre: z.string(),
      rol: texto.describe("Arrendador, cliente, proveedor, etc."),
      identificacion: texto,
    }),
  ),
  objeto: texto.describe("De qué trata el contrato, en una o dos frases"),
  monto: numero,
  moneda,
  periodicidad_pago: texto,
  clausulas_clave: z.array(z.string()),
  jurisdiccion: texto,
});
export type Contrato = z.infer<typeof ContratoExtraido>;

export const ContratoSchema = z.object({
  titulo: textoOpc,
  tipo_contrato: textoReq,
  fecha_firma: fechaReq,
  fecha_inicio: fechaOpc,
  fecha_fin: fechaOpc,
  partes: z
    .array(
      z.object({
        nombre: textoReq,
        rol: textoReq,
        identificacion: textoOpc,
      }),
    )
    .min(2, "Un contrato necesita al menos dos partes"),
  objeto: textoReq,
  monto: numeroOpc,
  moneda: monedaReq.nullable(),
  periodicidad_pago: textoOpc,
  clausulas_clave: z.array(textoReq),
  jurisdiccion: textoOpc,
});

export const ContratoReglas = ContratoExtraido.superRefine((c, ctx) => {
  if (fechaAntes(c.fecha_inicio, c.fecha_fin) === false) {
    ctx.addIssue({
      code: "custom",
      path: ["fecha_fin"],
      message: "La fecha de fin es anterior a la de inicio",
    });
  }
  if (c.monto != null && !c.moneda) {
    ctx.addIssue({
      code: "custom",
      path: ["moneda"],
      message: "Indica la moneda del monto",
    });
  }
});

export const contratoVacio = (): Contrato => ({
  titulo: null,
  tipo_contrato: null,
  fecha_firma: null,
  fecha_inicio: null,
  fecha_fin: null,
  partes: [],
  objeto: null,
  monto: null,
  moneda: null,
  periodicidad_pago: null,
  clausulas_clave: [],
  jurisdiccion: null,
});
