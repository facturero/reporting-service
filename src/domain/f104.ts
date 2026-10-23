import { dedupe, type DocDetail } from './ats.js';
import { FINDING_CODES, taxTotalFindings, warning, type Finding } from './findings.js';
import { MANUAL_FIELDS, manualValue } from './manual-fields.js';
import type { ReportDocument } from './reporting.js';

export interface F104Input {
  period: string;
  /** Ventas ACTIVAS del periodo (facturas, notas de crédito y de débito). */
  sales: DocDetail[];
  /** Compras ACTIVAS del periodo. */
  purchases: DocDetail[];
  /** Retenciones emitidas ACTIVAS del periodo. */
  retentions: DocDetail[];
  manual: ReadonlyMap<string, number>;
}

export interface TarifaTotal {
  ratePercent: number;
  baseCents: number;
  ivaCents: number;
}

/** Nota de crédito (04) resta; todo lo demás (factura, nota de débito) suma. */
const sign = (d: ReportDocument): 1 | -1 => (d.documentTypeCode === '04' ? -1 : 1);

function byRate(items: DocDetail[]): { porTarifa: Record<string, TarifaTotal>; ivaCents: number } {
  const map = new Map<number, TarifaTotal>();
  for (const { document, taxes } of items) {
    const s = sign(document);
    for (const t of taxes) {
      if (t.kind !== 'iva') continue;
      const row = map.get(t.ratePercent) ?? { ratePercent: t.ratePercent, baseCents: 0, ivaCents: 0 };
      row.baseCents += s * t.baseCents;
      row.ivaCents += s * t.amountCents;
      map.set(t.ratePercent, row);
    }
  }
  const porTarifa: Record<string, TarifaTotal> = {};
  for (const rate of [...map.keys()].sort((a, b) => a - b)) porTarifa[String(rate)] = map.get(rate)!;
  return { porTarifa, ivaCents: [...map.values()].reduce((s, r) => s + r.ivaCents, 0) };
}

/**
 * Formulario 104 (IVA) como BORRADOR para que el contador lo revise: el sistema entrega las cifras que sí puede calcular y deja como
 * casilleros manuales las que dependen de su criterio.
 *
 * Liquidación (misma estructura que la declaración):
 *   IVA generado en ventas (neto de notas de crédito)
 *   − crédito tributario por compras (IVA de compras × factor de proporcionalidad)
 *   − crédito tributario del mes anterior            (manual)
 *   − IVA que nos retuvieron los clientes            (manual: no llega por ningún evento)
 *   ± ajustes                                         (manual)
 *   = impuesto a pagar (positivo) o saldo a favor (negativo)
 * El IVA que NOSOTROS retuvimos a proveedores se paga aparte y no entra en esta cuenta: va en `ivaRetenidoPracticadoCents`.
 *
 * No se mapea a casilleros del formulario: la tabla oficial no está en el repositorio.
 */
export function calculateF104(input: F104Input): { content: unknown; summary: unknown; findings: Finding[] } {
  const findings: Finding[] = [];
  const ventas = byRate(input.sales);
  const compras = byRate(input.purchases);
  for (const { document, taxes } of [...input.sales, ...input.purchases]) findings.push(...taxTotalFindings(document, taxes));

  let ivaRetenidoPracticadoCents = 0;
  for (const { lines } of input.retentions) for (const l of lines) if (l.tax === 'vat') ivaRetenidoPracticadoCents += l.amountCents;

  const factorBps = manualValue('f104', 'factor_proporcionalidad_bps', input.manual);
  const creditoAnteriorCents = manualValue('f104', 'credito_anterior', input.manual);
  const ivaRetenidoSufridoCents = manualValue('f104', 'iva_retenido_sufrido', input.manual);
  const ajustesCents = manualValue('f104', 'ajustes', input.manual);

  const creditoAplicableCents = Math.round((compras.ivaCents * factorBps) / 10_000);
  const saldoCents = ventas.ivaCents - creditoAplicableCents - creditoAnteriorCents - ivaRetenidoSufridoCents + ajustesCents;

  const pendientes = Object.keys(MANUAL_FIELDS.f104).filter((code) => !input.manual.has(code));
  if (pendientes.length > 0) {
    findings.push(
      warning(
        FINDING_CODES.MANUAL_FIELDS_PENDING,
        `Casilleros que debe completar el contador y se calcularon con su valor predeterminado: ${pendientes.join(', ')}. Cambian lo que se paga.`,
      ),
    );
  }

  const content = {
    periodo: input.period,
    ventas: { porTarifa: ventas.porTarifa, ivaGeneradoNetoCents: ventas.ivaCents },
    compras: { porTarifa: compras.porTarifa, ivaCents: compras.ivaCents },
    camposManuales: { factorProporcionalidadBps: factorBps, creditoAnteriorCents, ivaRetenidoSufridoCents, ajustesCents },
    camposManualesPendientes: pendientes,
    liquidacion: {
      ivaGeneradoCents: ventas.ivaCents,
      creditoAplicableCents,
      creditoAnteriorCents,
      ivaRetenidoSufridoCents,
      ajustesCents,
      saldoCents,
      resultado: saldoCents > 0 ? 'a_pagar' : saldoCents < 0 ? 'a_favor' : 'cero',
    },
    ivaRetenidoPracticadoCents,
  };
  const summary = {
    ventas: input.sales.length,
    compras: input.purchases.length,
    retenciones: input.retentions.length,
    ivaGeneradoCents: ventas.ivaCents,
    ivaComprasCents: compras.ivaCents,
    creditoAplicableCents,
    saldoCents,
    ivaRetenidoPracticadoCents,
  };
  return { content, summary, findings: dedupe(findings) };
}
