import { dedupe, type DocDetail } from './ats.js';
import { FINDING_CODES, partyFindings, warning, type Finding } from './findings.js';

export interface F103Input {
  period: string;
  /** Retenciones emitidas ACTIVAS cuya fecha de emisión cae en el periodo. */
  retentions: DocDetail[];
}

export interface ConceptTotal {
  baseCents: number;
  valorRetenidoCents: number;
  /** Porcentajes con que se retuvo este concepto (casi siempre uno). */
  porcentajes: number[];
  retenciones: number;
  /** Casillero del formulario 103. `null` mientras no tengamos la tabla oficial concepto → casillero en un archivo. */
  casillero: null;
}

/**
 * Retenciones en la fuente de RENTA practicadas en el periodo, por código de concepto del SRI.
 *
 * Solo entran las líneas de renta: las de IVA van en el 104 y el ISD en su propio formulario. El código se muestra tal cual lo emitió
 * fiscal-ecuador; NO se traduce a un casillero ni se le pone descripción porque la tabla oficial no está en el repositorio.
 */
export function calculateF103(input: F103Input): { content: unknown; summary: unknown; findings: Finding[] } {
  const findings: Finding[] = [];
  const byConcept = new Map<string, { baseCents: number; valorRetenidoCents: number; rates: Set<number>; docs: Set<string> }>();
  let otrosImpuestosCents = 0;

  for (const { document, lines } of [...input.retentions].sort((a, b) => a.document.issueDate.localeCompare(b.document.issueDate) || a.document.id.localeCompare(b.document.id))) {
    findings.push(...partyFindings(document, 'Sujeto retenido'));
    if (!document.authorizationNumber) {
      findings.push(warning(FINDING_CODES.MISSING_AUTHORIZATION, `Retención ${document.establishment}-${document.emissionPoint}-${document.sequential}: sin número de autorización.`, document.id));
    }
    for (const line of lines) {
      if (line.tax !== 'income') {
        otrosImpuestosCents += line.amountCents;
        continue;
      }
      const c = byConcept.get(line.conceptCode) ?? { baseCents: 0, valorRetenidoCents: 0, rates: new Set<number>(), docs: new Set<string>() };
      c.baseCents += line.baseCents;
      c.valorRetenidoCents += line.amountCents;
      c.rates.add(line.ratePercent);
      c.docs.add(document.id);
      byConcept.set(line.conceptCode, c);
    }
  }

  const totalesPorConcepto: Record<string, ConceptTotal> = {};
  for (const code of [...byConcept.keys()].sort()) {
    const c = byConcept.get(code)!;
    totalesPorConcepto[code] = {
      baseCents: c.baseCents,
      valorRetenidoCents: c.valorRetenidoCents,
      porcentajes: [...c.rates].sort((a, b) => a - b),
      retenciones: c.docs.size,
      casillero: null,
    };
  }
  const totals = Object.values(totalesPorConcepto);
  const totalBaseCents = totals.reduce((s, t) => s + t.baseCents, 0);
  const totalRetenidoCents = totals.reduce((s, t) => s + t.valorRetenidoCents, 0);

  return {
    content: { periodo: input.period, totalesPorConcepto, retencionesIvaEIsdNoIncluidasCents: otrosImpuestosCents },
    summary: { conceptos: totals.length, retenciones: input.retentions.length, totalBaseCents, totalRetenidoCents, retencionesIvaEIsdNoIncluidasCents: otrosImpuestosCents },
    findings: dedupe(findings),
  };
}
