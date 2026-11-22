"use client";

import { createContext, useContext, useId, type ReactNode } from "react";
import type { Extraccion, TipoDocumento } from "@/lib/extraction-schema";
import { contratoVacio } from "@/lib/schemas/contrato";
import { facturaVacia } from "@/lib/schemas/factura";
import { reciboVacio } from "@/lib/schemas/recibo";
import type { Errores } from "@/lib/validation";

type Path = (string | number)[];

type FormCtx = {
  doc: Extraccion;
  errores: Errores;
  set: (path: Path, value: unknown) => void;
};

const Ctx = createContext<FormCtx | null>(null);
const useForm = () => useContext(Ctx)!;

const key = (path: Path) => path.join(".");

function getIn(obj: unknown, path: Path): unknown {
  return path.reduce<unknown>(
    (acc, k) => (acc == null ? undefined : (acc as Record<string | number, unknown>)[k]),
    obj,
  );
}

/** Copia inmutable de `obj` con `value` en `path`. */
function setIn<T>(obj: T, path: Path, value: unknown): T {
  if (path.length === 0) return value as T;
  const [head, ...rest] = path;
  const current = (obj as Record<string | number, unknown>)[head];
  const next = setIn(current, rest, value);
  if (Array.isArray(obj)) {
    const copy = [...obj];
    copy[head as number] = next;
    return copy as T;
  }
  return { ...(obj as object), [head]: next } as T;
}

// ---------------------------------------------------------------------------
// Campos

const inputBase =
  "w-full rounded-lg border px-2.5 py-1.5 text-sm outline-none transition-colors focus:ring-2";
const inputOk =
  "border-zinc-300 bg-white focus:border-indigo-500 focus:ring-indigo-500/20 dark:border-zinc-700 dark:bg-zinc-900";
const inputError =
  "border-red-500 bg-red-50 text-red-900 focus:ring-red-500/20 dark:bg-red-950/40 dark:text-red-100";

type FieldProps = {
  path: Path;
  label: string;
  type?: "text" | "number" | "date" | "textarea";
  /** Si es false, un campo vacío se guarda como "" en vez de null. */
  nullable?: boolean;
  className?: string;
};

function Field({ path, label, type = "text", nullable = true, className = "" }: FieldProps) {
  const { doc, errores, set } = useForm();
  const id = useId();
  const error = errores[key(path)];
  const raw = getIn(doc, path) as string | number | null | undefined;
  const value = raw == null || (typeof raw === "number" && Number.isNaN(raw)) ? "" : String(raw);

  const onChange = (v: string) => {
    if (type === "number") set(path, v === "" ? null : Number(v));
    else set(path, v === "" && nullable ? null : v);
  };

  const common = {
    id,
    value,
    "aria-invalid": !!error,
    "aria-describedby": error ? `${id}-error` : undefined,
    className: `${inputBase} ${error ? inputError : inputOk}`,
  };

  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className}`}>
      <label htmlFor={id} className="text-xs font-medium text-zinc-500">
        {label}
      </label>
      {type === "textarea" ? (
        <textarea {...common} rows={2} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input
          {...common}
          type={type === "number" ? "number" : "text"}
          step={type === "number" ? "any" : undefined}
          inputMode={type === "number" ? "decimal" : undefined}
          placeholder={type === "date" ? "AAAA-MM-DD" : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {error && (
        <p id={`${id}-error`} className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

function Section({ title, path, children }: { title: string; path?: Path; children: ReactNode }) {
  const { errores } = useForm();
  const error = path ? errores[key(path)] : undefined;
  return (
    <fieldset className="flex flex-col gap-3 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
      <legend className="px-1 text-sm font-semibold">{title}</legend>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      {children}
    </fieldset>
  );
}

const grid = "grid gap-3 sm:grid-cols-2";

function Parte({ path }: { path: Path }) {
  return (
    <div className={grid}>
      <Field path={[...path, "nombre"]} label="Nombre" />
      <Field path={[...path, "identificacion_fiscal"]} label="Identificación fiscal" />
      <Field path={[...path, "direccion"]} label="Dirección" className="sm:col-span-2" />
    </div>
  );
}

/** Lista editable: filas con botón para quitar y uno para añadir. */
function Rows<T>({
  path,
  empty,
  addLabel,
  children,
}: {
  path: Path;
  empty: () => T;
  addLabel: string;
  children: (rowPath: Path, index: number) => ReactNode;
}) {
  const { doc, set } = useForm();
  const items = (getIn(doc, path) as T[] | undefined) ?? [];
  return (
    <div className="flex flex-col gap-3">
      {items.map((_, i) => (
        <div key={i} className="flex items-start gap-2">
          <div className="min-w-0 flex-1">{children([...path, i], i)}</div>
          <button
            type="button"
            onClick={() => set(path, items.filter((__, j) => j !== i))}
            aria-label="Quitar fila"
            className="mt-5 rounded-lg px-2 py-1.5 text-sm text-zinc-400 hover:bg-zinc-100 hover:text-red-600 dark:hover:bg-zinc-800"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => set(path, [...items, empty()])}
        className="self-start rounded-lg border border-dashed border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:border-zinc-400 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
      >
        + {addLabel}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formularios por tipo

function FacturaForm() {
  const p = ["factura"];
  return (
    <>
      <Section title="Datos de la factura">
        <div className={grid}>
          <Field path={[...p, "numero"]} label="Número / folio" />
          <Field path={[...p, "serie"]} label="Serie" />
          <Field path={[...p, "fecha_emision"]} label="Fecha de emisión" type="date" />
          <Field path={[...p, "fecha_vencimiento"]} label="Fecha de vencimiento" type="date" />
          <Field path={[...p, "forma_pago"]} label="Forma de pago" />
          <Field path={[...p, "folio_fiscal"]} label="Folio fiscal (UUID)" />
        </div>
      </Section>
      <Section title="Emisor">
        <Parte path={[...p, "emisor"]} />
      </Section>
      <Section title="Receptor">
        <Parte path={[...p, "receptor"]} />
      </Section>
      <Section title="Conceptos" path={[...p, "conceptos"]}>
        <Rows
          path={[...p, "conceptos"]}
          addLabel="Añadir concepto"
          empty={() => ({ descripcion: "", cantidad: null, precio_unitario: null, importe: null })}
        >
          {(row) => (
            <div className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr_1fr]">
              <Field path={[...row, "descripcion"]} label="Descripción" nullable={false} />
              <Field path={[...row, "cantidad"]} label="Cantidad" type="number" />
              <Field path={[...row, "precio_unitario"]} label="P. unitario" type="number" />
              <Field path={[...row, "importe"]} label="Importe" type="number" />
            </div>
          )}
        </Rows>
      </Section>
      <Section title="Impuestos">
        <Rows
          path={[...p, "impuestos"]}
          addLabel="Añadir impuesto"
          empty={() => ({ tipo: "", tasa: null, importe: null })}
        >
          {(row) => (
            <div className="grid gap-2 sm:grid-cols-3">
              <Field path={[...row, "tipo"]} label="Tipo (IVA, retención ISR…)" nullable={false} />
              <Field path={[...row, "tasa"]} label="Tasa %" type="number" />
              <Field path={[...row, "importe"]} label="Importe" type="number" />
            </div>
          )}
        </Rows>
      </Section>
      <Section title="Totales">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field path={[...p, "subtotal"]} label="Subtotal" type="number" />
          <Field path={[...p, "total"]} label="Total" type="number" />
          <Field path={[...p, "moneda"]} label="Moneda" />
        </div>
        <p className="text-xs text-zinc-500">
          Se comprueba que subtotal + impuestos = total. Las retenciones se restan.
        </p>
      </Section>
    </>
  );
}

function ReciboForm() {
  const p = ["recibo"];
  return (
    <>
      <Section title="Datos del recibo">
        <div className={grid}>
          <Field path={[...p, "numero"]} label="Número" />
          <Field path={[...p, "fecha"]} label="Fecha" type="date" />
          <Field path={[...p, "concepto"]} label="Concepto" type="textarea" className="sm:col-span-2" />
          <Field path={[...p, "monto"]} label="Monto" type="number" />
          <Field path={[...p, "moneda"]} label="Moneda" />
          <Field path={[...p, "metodo_pago"]} label="Método de pago" />
        </div>
      </Section>
      <Section title="Emisor (quien cobra)">
        <Parte path={[...p, "emisor"]} />
      </Section>
      <Section title="Pagador">
        <Parte path={[...p, "pagador"]} />
      </Section>
    </>
  );
}

function ContratoForm() {
  const p = ["contrato"];
  return (
    <>
      <Section title="Datos del contrato">
        <div className={grid}>
          <Field path={[...p, "titulo"]} label="Título" className="sm:col-span-2" />
          <Field path={[...p, "tipo_contrato"]} label="Tipo de contrato" />
          <Field path={[...p, "jurisdiccion"]} label="Jurisdicción" />
          <Field path={[...p, "fecha_firma"]} label="Fecha de firma" type="date" />
          <div className="hidden sm:block" />
          <Field path={[...p, "fecha_inicio"]} label="Fecha de inicio" type="date" />
          <Field path={[...p, "fecha_fin"]} label="Fecha de fin" type="date" />
          <Field path={[...p, "objeto"]} label="Objeto" type="textarea" className="sm:col-span-2" />
        </div>
      </Section>
      <Section title="Partes" path={[...p, "partes"]}>
        <Rows
          path={[...p, "partes"]}
          addLabel="Añadir parte"
          empty={() => ({ nombre: "", rol: null, identificacion: null })}
        >
          {(row) => (
            <div className="grid gap-2 sm:grid-cols-3">
              <Field path={[...row, "nombre"]} label="Nombre" nullable={false} />
              <Field path={[...row, "rol"]} label="Rol" />
              <Field path={[...row, "identificacion"]} label="Identificación" />
            </div>
          )}
        </Rows>
      </Section>
      <Section title="Condiciones económicas">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field path={[...p, "monto"]} label="Monto" type="number" />
          <Field path={[...p, "moneda"]} label="Moneda" />
          <Field path={[...p, "periodicidad_pago"]} label="Periodicidad de pago" />
        </div>
      </Section>
      <Section title="Cláusulas clave">
        <Rows path={[...p, "clausulas_clave"]} addLabel="Añadir cláusula" empty={() => ""}>
          {(row, i) => (
            <Field path={row} label={`Cláusula ${i + 1}`} type="textarea" nullable={false} />
          )}
        </Rows>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------

const TIPOS: { value: TipoDocumento; label: string }[] = [
  { value: "factura", label: "Factura" },
  { value: "recibo", label: "Recibo" },
  { value: "contrato", label: "Contrato" },
  { value: "otro", label: "Otro documento" },
];

const VACIOS = { factura: facturaVacia, recibo: reciboVacio, contrato: contratoVacio };

export default function DocumentForm({
  doc,
  errores,
  onChange,
}: {
  doc: Extraccion;
  errores: Errores;
  onChange: (doc: Extraccion) => void;
}) {
  const set = (path: Path, value: unknown) => onChange(setIn(doc, path, value));

  const cambiarTipo = (tipo: TipoDocumento) => {
    let next: Extraccion = { ...doc, tipo_documento: tipo };
    if (tipo !== "otro" && !next[tipo]) next = { ...next, [tipo]: VACIOS[tipo]() };
    onChange(next);
  };

  return (
    <Ctx.Provider value={{ doc, errores, set }}>
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-[auto_1fr] sm:items-end">
          <div className="flex flex-col gap-1">
            <label htmlFor="tipo-documento" className="text-xs font-medium text-zinc-500">
              Tipo de documento
            </label>
            <select
              id="tipo-documento"
              value={doc.tipo_documento}
              onChange={(e) => cambiarTipo(e.target.value as TipoDocumento)}
              className={`${inputBase} ${inputOk}`}
            >
              {TIPOS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{doc.resumen}</p>
        </div>

        {doc.tipo_documento === "factura" && <FacturaForm />}
        {doc.tipo_documento === "recibo" && <ReciboForm />}
        {doc.tipo_documento === "contrato" && <ContratoForm />}
        {doc.tipo_documento === "otro" && (
          <p className="rounded-xl border border-zinc-200 p-4 text-sm text-zinc-500 dark:border-zinc-800">
            El modelo no lo reconoció como factura, recibo ni contrato. Si lo es, elige el tipo arriba
            y completa los datos.
          </p>
        )}

        <Field path={["notas"]} label="Notas del modelo" type="textarea" />
      </div>
    </Ctx.Provider>
  );
}
