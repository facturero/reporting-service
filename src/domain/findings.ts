import { checkParty, normalizeIdentificationType } from './party.js';
import type { ReportDocument, ReportDocumentTax, ReportWithholdingLine } from './reporting.js';
import { UNKNOWN_DOCUMENT_TYPE } from './reporting.js';

export type FindingSeverity = 'error' | 'warning';

export interface Finding {
  severity: FindingSeverity;
  code: string;
  message: string;
  documentId: string | null;
}

export const FINDING_CODES = {
  INVALID_PARTY_ID: 'INVALID_PARTY_ID',
  MISSING_PARTY_ID: 'MISSING_PARTY_ID',
  MISSING_PARTY_ID_TYPE: 'MISSING_PARTY_ID_TYPE',
  MISSING_PARTY_NAME: 'MISSING_PARTY_NAME',
  MISSING_AUTHORIZATION: 'MISSING_AUTHORIZATION',
  INVALID_AUTHORIZATION_FORMAT: 'INVALID_AUTHORIZATION_FORMAT',
  MISSING_SUPPORT_CODE: 'MISSING_SUPPORT_CODE',
  DUPLICATE_DOCUMENT: 'DUPLICATE_DOCUMENT',
  TAX_BASE_MISMATCH: 'TAX_BASE_MISMATCH',
  NO_TAX_DETAIL: 'NO_TAX_DETAIL',
  WITHHOLDING_WITHOUT_PURCHASE: 'WITHHOLDING_WITHOUT_PURCHASE',
  VOIDED_WITH_WITHHOLDING: 'VOIDED_WITH_WITHHOLDING',
  UNKNOWN_DOCUMENT_TYPE: 'UNKNOWN_DOCUMENT_TYPE',
  MISSING_INFORMANT: 'MISSING_INFORMANT',
  MANUAL_FIELDS_PENDING: 'MANUAL_FIELDS_PENDING',
} as const;

const make = (severity: FindingSeverity) => (code: string, message: string, documentId: string | null = null): Finding => ({ severity, code, message, documentId });
export const error = make('error');
export const warning = make('warning');

const documentLabel = (d: ReportDocument): string => `${d.establishment}-${d.emissionPoint}-${d.sequential}`;

/** El tercero del documento: identificación, tipo y nombre. */
export function partyFindings(d: ReportDocument, who: string): Finding[] {
  const type = normalizeIdentificationType(d.partyIdentificationType);
  return checkParty({ type, identification: d.partyIdentification, name: d.partyName }).map((p) =>
    p.problem === 'MISSING_PARTY_NAME' || p.problem === 'MISSING_PARTY_ID_TYPE' || p.certainty === 'low'
      ? warning(p.problem, `${who} ${documentLabel(d)}: ${p.message}`, d.id)
      : error(p.problem, `${who} ${documentLabel(d)}: ${p.message}`, d.id),
  );
}

/** Autorización del comprobante (10 a 49 dígitos). Las compras la necesitan para el ATS; las ventas no (el ATS de ventas va agrupado). */
export function authorizationFindings(d: ReportDocument): Finding[] {
  if (!d.authorizationNumber) return [error(FINDING_CODES.MISSING_AUTHORIZATION, `${documentLabel(d)}: falta el número de autorización.`, d.id)];
  if (!/^\d{10,49}$/.test(d.authorizationNumber)) {
    return [error(FINDING_CODES.INVALID_AUTHORIZATION_FORMAT, `${documentLabel(d)}: la autorización debe tener entre 10 y 49 dígitos.`, d.id)];
  }
  return [];
}

/**
 * Que las bases y el impuesto del desglose sumen el total del documento. Es una ADVERTENCIA y no un error: el desglose puede no incluir
 * líneas sin impuesto, y un descuento global o un redondeo del proveedor puede dejar una diferencia legítima.
 */
export function taxTotalFindings(d: ReportDocument, taxes: ReportDocumentTax[]): Finding[] {
  if (d.totalCents === 0) return [];
  if (taxes.length === 0) return [warning(FINDING_CODES.NO_TAX_DETAIL, `${documentLabel(d)}: no trae el desglose de impuestos; no se puede repartir por tarifa.`, d.id)];
  const iva = taxes.filter((t) => t.kind === 'iva');
  const expected =
    iva.reduce((s, t) => s + t.baseCents + t.amountCents, 0) +
    taxes.filter((t) => t.kind !== 'iva').reduce((s, t) => s + t.amountCents, 0);
  if (Math.abs(expected - d.totalCents) > 1) {
    return [warning(FINDING_CODES.TAX_BASE_MISMATCH, `${documentLabel(d)}: las bases e impuestos suman ${expected} centavos y el total es ${d.totalCents}.`, d.id)];
  }
  return [];
}

/** El mismo comprobante dos veces (mismo tercero y mismo número, o mismo número y tipo en ventas). */
export function duplicateFindings(documents: ReportDocument[]): Finding[] {
  const seen = new Map<string, ReportDocument>();
  const out: Finding[] = [];
  for (const d of documents) {
    if (d.status !== 'active') continue;
    const key = [d.direction, d.documentTypeCode, d.partyIdentification ?? '', d.establishment, d.emissionPoint, d.sequential].join('|');
    const first = seen.get(key);
    if (first) out.push(error(FINDING_CODES.DUPLICATE_DOCUMENT, `${documentLabel(d)} aparece dos veces en el periodo.`, d.id));
    else seen.set(key, d);
  }
  return out;
}

export function unknownTypeFindings(d: ReportDocument): Finding[] {
  if (d.documentTypeCode !== UNKNOWN_DOCUMENT_TYPE) return [];
  return [warning(FINDING_CODES.UNKNOWN_DOCUMENT_TYPE, `${documentLabel(d)}: se anuló antes de conocerse el comprobante; no se sabe de qué tipo era.`, d.id)];
}

/** Retención sin compra enlazada, o enlazada a una compra anulada. */
export function withholdingLinkFindings(d: ReportDocument, lines: ReportWithholdingLine[], purchaseVoided: boolean): Finding[] {
  const out: Finding[] = [];
  if (!lines.some((l) => l.supportsSourceId)) {
    out.push(warning(FINDING_CODES.WITHHOLDING_WITHOUT_PURCHASE, `Retención ${documentLabel(d)}: la compra que sustenta no está en el sistema (normal si se registró fuera de Compras).`, d.id));
  }
  if (purchaseVoided) out.push(warning(FINDING_CODES.VOIDED_WITH_WITHHOLDING, `Retención ${documentLabel(d)}: la compra que sustenta fue anulada.`, d.id));
  return out;
}
