import { authorizationFindings, duplicateFindings, FINDING_CODES, partyFindings, taxTotalFindings, unknownTypeFindings, warning, withholdingLinkFindings, type Finding } from './findings.js';
import { normalizeIdentificationType } from './party.js';
import type { ReportDocument, ReportDocumentTax, ReportWithholdingLine } from './reporting.js';

/** Un documento con su desglose de impuestos y, si es una retención, sus líneas. */
export interface DocDetail {
  document: ReportDocument;
  taxes: ReportDocumentTax[];
  lines: ReportWithholdingLine[];
}

export interface Informant {
  ruc: string;
  legalName: string;
}

export interface AtsInput {
  period: string;
  documents: DocDetail[];
  informant: Informant | null;
}

export interface Bases {
  /** Base de las líneas con IVA 0 %. Compras y ventas no distinguen «no objeto» ni «exento» (billing y compras solo traen la tarifa). */
  base0Cents: number;
  baseGravadaCents: number;
  ivaCents: number;
  iceCents: number;
  irbpnrCents: number;
}

export function basesOf(taxes: ReportDocumentTax[]): Bases {
  const out: Bases = { base0Cents: 0, baseGravadaCents: 0, ivaCents: 0, iceCents: 0, irbpnrCents: 0 };
  for (const t of taxes) {
    if (t.kind === 'iva') {
      if (t.ratePercent === 0) out.base0Cents += t.baseCents;
      else out.baseGravadaCents += t.baseCents;
      out.ivaCents += t.amountCents;
    } else if (t.kind === 'ice') out.iceCents += t.amountCents;
    else out.irbpnrCents += t.amountCents;
  }
  return out;
}

const number = (d: ReportDocument) => `${d.establishment}-${d.emissionPoint}-${d.sequential}`;

const byOrder = (a: ReportDocument, b: ReportDocument) =>
  a.issueDate.localeCompare(b.issueDate) || number(a).localeCompare(number(b)) || a.id.localeCompare(b.id);

const sum = (items: number[]) => items.reduce((s, v) => s + v, 0);

/**
 * ATS del periodo, en una estructura PROPIA: compras con sus retenciones, ventas por cliente y tipo de comprobante, anulados y retenciones
 * sin compra. Todo en centavos enteros.
 *
 * Esto NO es el XML del SRI. El mapeo a los nodos del esquema oficial se escribe cuando el XSD esté en el servicio (hoy no lo está), y
 * la exportación en XML responde `ATS_SCHEMA_PENDING` mientras tanto.
 */
export function calculateAts(input: AtsInput): { content: unknown; summary: unknown; findings: Finding[] } {
  const { period, informant } = input;
  const docs = [...input.documents].sort((a, b) => byOrder(a.document, b.document));
  const findings: Finding[] = [];
  if (!informant) findings.push(warning(FINDING_CODES.MISSING_INFORMANT, 'No se pudo leer el RUC y la razón social de la organización: el informante del ATS queda vacío.'));
  findings.push(...duplicateFindings(docs.map((d) => d.document)));

  const statusBySource = new Map(docs.map((d) => [d.document.sourceId, d.document.status]));
  const retentions = docs.filter((d) => d.document.direction === 'withholding_issued' && d.document.status === 'active');
  const retentionsByPurchase = new Map<string, DocDetail[]>();
  for (const r of retentions) {
    if (!r.document.relatedSourceId) continue;
    const list = retentionsByPurchase.get(r.document.relatedSourceId) ?? [];
    list.push(r);
    retentionsByPurchase.set(r.document.relatedSourceId, list);
  }

  // ── Compras ────────────────────────────────────────────────────────────────
  const compras = docs
    .filter((d) => d.document.direction === 'purchase' && d.document.status === 'active')
    .map(({ document: d, taxes }) => {
      findings.push(...partyFindings(d, 'Proveedor'), ...authorizationFindings(d), ...taxTotalFindings(d, taxes));
      if (!d.supportCode) {
        findings.push(warning(FINDING_CODES.MISSING_SUPPORT_CODE, `Compra ${number(d)}: falta el sustento tributario que exige el ATS (Compras todavía no lo captura).`, d.id));
      }
      return {
        documentId: d.id,
        fechaEmision: d.issueDate,
        tipoComprobante: d.documentTypeCode,
        establecimiento: d.establishment,
        puntoEmision: d.emissionPoint,
        secuencial: d.sequential,
        autorizacion: d.authorizationNumber,
        sustento: d.supportCode,
        formaPago: d.paymentMethodCode,
        tipoIdentificacion: normalizeIdentificationType(d.partyIdentificationType),
        identificacion: d.partyIdentification,
        proveedor: d.partyName,
        ...basesOf(taxes),
        totalCents: d.totalCents,
        retenciones: (retentionsByPurchase.get(d.sourceId) ?? []).map((r) => ({
          documentId: r.document.id,
          numero: number(r.document),
          autorizacion: r.document.authorizationNumber,
          fechaEmision: r.document.issueDate,
          lineas: r.lines.map((l) => ({ impuesto: l.tax, concepto: l.conceptCode, porcentaje: l.ratePercent, baseCents: l.baseCents, valorCents: l.amountCents })),
        })),
      };
    });

  // ── Ventas: una fila por cliente y tipo de comprobante. Los importes van en positivo dentro de su propio tipo (la nota de crédito suma en su fila, no resta en la de la factura). ──
  const groups = new Map<string, { tipoIdentificacion: string | null; identificacion: string | null; cliente: string | null; tipoComprobante: string; comprobantes: number } & Bases>();
  for (const { document: d, taxes } of docs) {
    if (d.direction !== 'sale' || d.status !== 'active') continue;
    findings.push(...partyFindings(d, 'Cliente'), ...taxTotalFindings(d, taxes));
    const type = normalizeIdentificationType(d.partyIdentificationType);
    const key = [type ?? '', d.partyIdentification ?? '', d.documentTypeCode].join('|');
    const b = basesOf(taxes);
    const g = groups.get(key);
    if (g) {
      g.comprobantes += 1;
      g.base0Cents += b.base0Cents;
      g.baseGravadaCents += b.baseGravadaCents;
      g.ivaCents += b.ivaCents;
      g.iceCents += b.iceCents;
      g.irbpnrCents += b.irbpnrCents;
    } else {
      groups.set(key, { tipoIdentificacion: type, identificacion: d.partyIdentification, cliente: d.partyName, tipoComprobante: d.documentTypeCode, comprobantes: 1, ...b });
    }
  }
  const ventasPorCliente = [...groups.values()].sort(
    (a, b) => (a.identificacion ?? '').localeCompare(b.identificacion ?? '') || a.tipoComprobante.localeCompare(b.tipoComprobante),
  );

  // ── Anulados: ventas y retenciones del informante. Una compra anulada en Compras no es un comprobante anulado por él. ──
  const anulados = docs
    .filter((d) => d.document.status === 'voided' && d.document.direction !== 'purchase')
    .map(({ document: d }) => {
      findings.push(...unknownTypeFindings(d));
      return {
        documentId: d.id,
        origen: d.direction,
        tipoComprobante: d.documentTypeCode,
        establecimiento: d.establishment,
        puntoEmision: d.emissionPoint,
        secuencial: d.sequential,
        autorizacion: d.authorizationNumber,
        fechaEmision: d.issueDate,
        fechaAnulacion: d.voidedAt ? d.voidedAt.toISOString().slice(0, 10) : null,
      };
    });
  const comprasAnuladas = docs.filter((d) => d.document.direction === 'purchase' && d.document.status === 'voided').length;

  // ── Retenciones emitidas ───────────────────────────────────────────────────
  const retencionesSinCompra = retentions
    .filter((r) => !r.document.relatedSourceId)
    .map((r) => ({
      documentId: r.document.id,
      numero: number(r.document),
      autorizacion: r.document.authorizationNumber,
      fechaEmision: r.document.issueDate,
      proveedor: r.document.partyName,
      identificacion: r.document.partyIdentification,
      sustento: r.lines[0]?.supportDocumentNumber ?? null,
    }));
  for (const r of retentions) {
    findings.push(...partyFindings(r.document, 'Sujeto retenido'));
    if (!r.document.authorizationNumber) findings.push(warning(FINDING_CODES.MISSING_AUTHORIZATION, `Retención ${number(r.document)}: sin número de autorización.`, r.document.id));
    findings.push(...withholdingLinkFindings(r.document, r.lines, r.document.relatedSourceId ? statusBySource.get(r.document.relatedSourceId) === 'voided' : false));
  }

  const content = { periodo: period, informante: informant, compras, ventasPorCliente, anulados, retencionesSinCompra };
  const summary = {
    compras: compras.length,
    comprasAnuladas,
    comprobantesVenta: sum(ventasPorCliente.map((g) => g.comprobantes)),
    clientes: new Set(ventasPorCliente.map((g) => g.identificacion)).size,
    anulados: anulados.length,
    retencionesEmitidas: retentions.length,
    retencionesSinCompra: retencionesSinCompra.length,
    comprasBaseGravadaCents: sum(compras.map((c) => c.baseGravadaCents)),
    comprasBase0Cents: sum(compras.map((c) => c.base0Cents)),
    comprasIvaCents: sum(compras.map((c) => c.ivaCents)),
    ventasBaseGravadaCents: sum(ventasPorCliente.map((g) => g.baseGravadaCents)),
    ventasBase0Cents: sum(ventasPorCliente.map((g) => g.base0Cents)),
    ventasIvaCents: sum(ventasPorCliente.map((g) => g.ivaCents)),
  };
  return { content, summary, findings: dedupe(findings) };
}

/** Un mismo hallazgo (mismo código, documento y texto) no se repite. */
export function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    const key = `${f.code}|${f.documentId ?? ''}|${f.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}
