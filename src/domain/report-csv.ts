import type { AnnexType } from './reporting.js';

/** Un importe: siempre con dos decimales (`12.00`, no `12`), para que la columna se lea igual en cualquier fila. */
class Amount {
  constructor(readonly cents: number) {}
}

type Cell = string | number | Amount | null;

/**
 * Una celda de CSV. Los textos que empiezan por `= + - @` (o tabulación/retorno) se vuelven FÓRMULAS al abrir el archivo en Excel o
 * Sheets: el nombre de un proveedor lo escribe cualquiera, así que se les antepone un apóstrofo (guía de OWASP contra la inyección de
 * fórmulas). Los números no se tocan: un saldo negativo es un número, no una fórmula.
 */
export function csvCell(value: Cell): string {
  if (value === null) return '';
  if (value instanceof Amount) return (Math.round(value.cents) / 100).toFixed(2);
  if (typeof value === 'number') return String(value);
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n;]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function toCsv(rows: readonly (readonly Cell[])[]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

const money = (cents: number | null | undefined): Amount | null => (cents === null || cents === undefined ? null : new Amount(cents));

type Rec = Record<string, unknown>;
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? (v as Rec[]) : []);
const rec = (v: unknown): Rec => (v && typeof v === 'object' ? (v as Rec) : {});
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** ATS: cuatro tablas en un mismo archivo, separadas por una línea en blanco. NO es el XML del SRI. */
export function buildAtsCsv(content: unknown): string {
  const c = rec(content);
  const rows: Cell[][] = [['ATS', str(c.periodo)], []];

  rows.push(['COMPRAS'], ['Fecha', 'Tipo comprobante', 'Número', 'Autorización', 'Sustento', 'Tipo ID', 'Identificación', 'Proveedor', 'Base 0 %', 'Base gravada', 'IVA', 'ICE', 'IRBPNR', 'Total', 'Retenciones']);
  for (const x of arr(c.compras)) {
    rows.push([
      str(x.fechaEmision), str(x.tipoComprobante), `${str(x.establecimiento)}-${str(x.puntoEmision)}-${str(x.secuencial)}`, str(x.autorizacion), str(x.sustento),
      str(x.tipoIdentificacion), str(x.identificacion), str(x.proveedor),
      money(num(x.base0Cents)), money(num(x.baseGravadaCents)), money(num(x.ivaCents)), money(num(x.iceCents)), money(num(x.irbpnrCents)), money(num(x.totalCents)),
      arr(x.retenciones).map((r) => str(r.numero)).join(' / ') || null,
    ]);
  }

  rows.push([], ['VENTAS POR CLIENTE Y TIPO DE COMPROBANTE'], ['Tipo ID', 'Identificación', 'Cliente', 'Tipo comprobante', 'Comprobantes', 'Base 0 %', 'Base gravada', 'IVA', 'ICE', 'IRBPNR']);
  for (const x of arr(c.ventasPorCliente)) {
    rows.push([str(x.tipoIdentificacion), str(x.identificacion), str(x.cliente), str(x.tipoComprobante), num(x.comprobantes), money(num(x.base0Cents)), money(num(x.baseGravadaCents)), money(num(x.ivaCents)), money(num(x.iceCents)), money(num(x.irbpnrCents))]);
  }

  rows.push([], ['COMPROBANTES ANULADOS'], ['Origen', 'Tipo comprobante', 'Número', 'Autorización', 'Fecha emisión', 'Fecha anulación']);
  for (const x of arr(c.anulados)) {
    rows.push([str(x.origen), str(x.tipoComprobante), `${str(x.establecimiento)}-${str(x.puntoEmision)}-${str(x.secuencial)}`, str(x.autorizacion), str(x.fechaEmision), str(x.fechaAnulacion)]);
  }

  rows.push([], ['RETENCIONES CUYA COMPRA NO ESTÁ EN EL SISTEMA'], ['Número', 'Autorización', 'Fecha', 'Identificación', 'Proveedor', 'Comprobante sustento']);
  for (const x of arr(c.retencionesSinCompra)) rows.push([str(x.numero), str(x.autorizacion), str(x.fechaEmision), str(x.identificacion), str(x.proveedor), str(x.sustento)]);

  return toCsv(rows);
}

/** Formulario 103: una fila por código de concepto. */
export function buildF103Csv(content: unknown): string {
  const c = rec(content);
  const rows: Cell[][] = [['Formulario 103 - Retenciones en la fuente de renta', str(c.periodo)], [], ['Código de concepto', 'Casillero', 'Porcentajes', 'Retenciones', 'Base', 'Valor retenido']];
  const totals = rec(c.totalesPorConcepto);
  let base = 0;
  let valor = 0;
  for (const [code, raw] of Object.entries(totals)) {
    const t = rec(raw);
    base += num(t.baseCents);
    valor += num(t.valorRetenidoCents);
    rows.push([code, str(t.casillero), Array.isArray(t.porcentajes) ? (t.porcentajes as number[]).join(' / ') : null, num(t.retenciones), money(num(t.baseCents)), money(num(t.valorRetenidoCents))]);
  }
  rows.push(['TOTAL', null, null, null, money(base), money(valor)]);
  return toCsv(rows);
}

/** Formulario 104: ventas y compras por tarifa, la liquidación y los casilleros manuales. */
export function buildF104Csv(content: unknown): string {
  const c = rec(content);
  const ventas = rec(c.ventas);
  const compras = rec(c.compras);
  const liq = rec(c.liquidacion);
  const manual = rec(c.camposManuales);
  const rows: Cell[][] = [['Formulario 104 - IVA (borrador para revisión del contador)', str(c.periodo)], []];

  rows.push(['VENTAS (neto de notas de crédito)'], ['Tarifa %', 'Base', 'IVA']);
  for (const t of Object.values(rec(ventas.porTarifa))) rows.push([num(rec(t).ratePercent), money(num(rec(t).baseCents)), money(num(rec(t).ivaCents))]);
  rows.push(['IVA generado', null, money(num(ventas.ivaGeneradoNetoCents))], []);

  rows.push(['COMPRAS (IVA crédito)'], ['Tarifa %', 'Base', 'IVA']);
  for (const t of Object.values(rec(compras.porTarifa))) rows.push([num(rec(t).ratePercent), money(num(rec(t).baseCents)), money(num(rec(t).ivaCents))]);
  rows.push(['IVA de compras', null, money(num(compras.ivaCents))], []);

  rows.push(['LIQUIDACIÓN'], ['Concepto', 'Importe']);
  rows.push(['IVA generado en ventas', money(num(liq.ivaGeneradoCents))]);
  rows.push(['(-) Crédito tributario por compras', money(num(liq.creditoAplicableCents))]);
  rows.push(['(-) Crédito del mes anterior (manual)', money(num(liq.creditoAnteriorCents))]);
  rows.push(['(-) IVA retenido por clientes (manual)', money(num(liq.ivaRetenidoSufridoCents))]);
  rows.push(['(+/-) Ajustes (manual)', money(num(liq.ajustesCents))]);
  // Se muestra en positivo bajo su rótulo: «SALDO A FAVOR,-9.00» sería una doble negación.
  rows.push([str(liq.resultado) === 'a_favor' ? 'SALDO A FAVOR' : 'IMPUESTO A PAGAR', money(Math.abs(num(liq.saldoCents)))], []);

  rows.push(['IVA retenido a proveedores (se paga aparte)', money(num(c.ivaRetenidoPracticadoCents))], []);
  rows.push(['CASILLEROS MANUALES'], ['Factor de proporcionalidad (puntos básicos)', num(manual.factorProporcionalidadBps)]);
  if (Array.isArray(c.camposManualesPendientes) && c.camposManualesPendientes.length > 0) {
    rows.push(['Sin completar (valor predeterminado):', (c.camposManualesPendientes as string[]).join(' / ')]);
  }
  return toCsv(rows);
}

export function buildCsvFor(annex: AnnexType, content: unknown): string {
  if (annex === 'ats') return buildAtsCsv(content);
  if (annex === 'f103') return buildF103Csv(content);
  return buildF104Csv(content);
}
