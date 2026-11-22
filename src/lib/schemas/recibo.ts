import { z } from "zod";
import {
  ParteExtraida,
  fecha,
  fechaReq,
  importeReq,
  moneda,
  monedaReq,
  numero,
  texto,
  textoOpc,
  textoReq,
} from "./common";

export const ReciboExtraido = z.object({
  numero: texto,
  fecha: fecha,
  emisor: ParteExtraida,
  pagador: ParteExtraida,
  concepto: texto,
  monto: numero,
  moneda,
  metodo_pago: texto,
});
export type Recibo = z.infer<typeof ReciboExtraido>;

export const ReciboSchema = z.object({
  numero: textoOpc,
  fecha: fechaReq,
  emisor: z.object({
    nombre: textoReq,
    identificacion_fiscal: textoOpc,
    direccion: textoOpc,
  }),
  pagador: z.object({
    nombre: textoReq,
    identificacion_fiscal: textoOpc,
    direccion: textoOpc,
  }),
  concepto: textoReq,
  monto: importeReq.positive("Debe ser mayor que 0"),
  moneda: monedaReq,
  metodo_pago: textoOpc,
});

/** Un recibo no tiene reglas entre campos; se deja por simetría con los otros tipos. */
export const ReciboReglas = ReciboExtraido;

export const reciboVacio = (): Recibo => ({
  numero: null,
  fecha: null,
  emisor: { nombre: null, identificacion_fiscal: null, direccion: null },
  pagador: { nombre: null, identificacion_fiscal: null, direccion: null },
  concepto: null,
  monto: null,
  moneda: null,
  metodo_pago: null,
});
