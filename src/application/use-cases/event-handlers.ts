import { randomUUID } from 'node:crypto';
import { calendarDay } from '../../domain/dates.js';
import { normalizeIdentificationType } from '../../domain/party.js';
import { UNKNOWN_DOCUMENT_TYPE } from '../../domain/reporting.js';
import type {
  BillPostedPayload,
  BillVoidedPayload,
  InvoiceIssuedPayload,
  InvoiceVoidedPayload,
  ReportDocument,
  ReportDocumentTax,
  ReportWithholdingLine,
  UnitOfWork,
  UnitOfWorkGateway,
  WithholdingIssuedPayload,
} from '../../domain/reporting.js';
import { inTransaction, retryOnUnique } from './transaction.js';

export interface EventHandlerResult {
  outcome: 'created' | 'updated' | 'duplicate' | 'skipped';
  reason?: string;
}

export interface HandlerDeps {
  uow: UnitOfWorkGateway;
  timezone: string;
  clock: () => Date;
}

/** `ddd-ddd-ddddddddd` desde cualquier forma razonable del número. */
export function parseDocumentNumber(value: string | null | undefined): { establishment: string; emissionPoint: string; sequential: string; full: string } | null {
  const m = /^\s*(\d{3})-(\d{3})-(\d{1,9})\s*$/.exec(value ?? '');
  if (!m) return null;
  const sequential = m[3]!.padStart(9, '0');
  return { establishment: m[1]!, emissionPoint: m[2]!, sequential, full: `${m[1]}-${m[2]}-${sequential}` };
}

const clean = (v: string | null | undefined): string | null => v?.trim() || null;

const trimTo = (v: string | null, max: number): string | null => (v === null ? null : v.slice(0, max));

/** IVA es el único impuesto de billing que entra al desglose; las retenciones de la línea (`withholding_*`) y `special` no son IVA. */
function saleTaxes(documentId: string, payload: InvoiceIssuedPayload): ReportDocumentTax[] {
  const byRate = new Map<number, ReportDocumentTax>();
  for (const line of payload.lines ?? []) {
    for (const t of line.taxes ?? []) {
      if (t.kind !== 'vat') continue;
      const rate = Number.parseFloat(t.rateSnapshot);
      if (!Number.isFinite(rate)) continue;
      const row = byRate.get(rate) ?? { id: randomUUID(), documentId, kind: 'iva' as const, taxCode: '2', ratePercent: rate, baseCents: 0, amountCents: 0 };
      row.baseCents += t.baseCents;
      row.amountCents += t.amountCents;
      byRate.set(rate, row);
    }
  }
  return [...byRate.values()];
}

function purchaseTaxes(documentId: string, payload: BillPostedPayload): ReportDocumentTax[] {
  return (payload.taxBreakdown ?? []).map((t) => ({
    id: randomUUID(),
    documentId,
    kind: t.taxCode === '3' ? ('ice' as const) : t.taxCode === '5' ? ('irbpnr' as const) : ('iva' as const),
    taxCode: t.taxCode,
    ratePercent: t.ratePercent,
    baseCents: t.baseCents,
    amountCents: t.amountCents,
  }));
}

/** Completa un documento que nació «fantasma» (anulación antes del comprobante), conservando que está anulado. */
async function fillGhost(uow: UnitOfWork, ghost: ReportDocument, real: ReportDocument, taxes: ReportDocumentTax[]): Promise<void> {
  const completed: ReportDocument = { ...real, id: ghost.id, status: ghost.status, voidedAt: ghost.voidedAt, createdAt: ghost.createdAt };
  await uow.reportDocuments.update(completed, ghost.version);
  await uow.reportDocuments.saveTaxes(taxes.map((t) => ({ ...t, documentId: ghost.id })));
}

// ── Ventas ───────────────────────────────────────────────────────────────────

export class HandleInvoiceIssuedUseCase {
  constructor(private readonly deps: HandlerDeps) {}

  async execute(payload: InvoiceIssuedPayload): Promise<EventHandlerResult> {
    const { timezone, clock } = this.deps;
    const organizationId = payload.organizationId;
    if (!organizationId || !payload.invoiceId) return { outcome: 'skipped', reason: 'evento sin organización o sin id de comprobante' };
    if (!payload.documentTypeCode) return { outcome: 'skipped', reason: 'el comprobante no trae su tipo (documentTypeCode)' };

    const parsed =
      parseDocumentNumber(payload.number) ??
      (payload.issuerSnapshot && payload.sequentialNumber
        ? parseDocumentNumber(`${payload.issuerSnapshot.establishmentCode}-${payload.issuerSnapshot.emissionPointCode}-${payload.sequentialNumber}`)
        : null);
    if (!parsed) return { outcome: 'skipped', reason: `número de comprobante inválido: ${payload.number}` };

    // Sin fecha de emisión NO se inventa una: el anexo se arma por fecha de emisión y un comprobante con la fecha de hoy caería en el periodo equivocado.
    const issueDate = calendarDay(payload.issueDate, timezone);
    if (!issueDate) return { outcome: 'skipped', reason: 'el comprobante no trae fecha de emisión' };

    const customer = payload.customerSnapshot;
    const now = clock();
    const id = randomUUID();
    const document: ReportDocument = {
      id,
      organizationId,
      sourceService: 'billing',
      sourceId: payload.invoiceId,
      direction: 'sale',
      documentTypeCode: payload.documentTypeCode,
      establishment: parsed.establishment,
      emissionPoint: parsed.emissionPoint,
      sequential: parsed.sequential,
      authorizationNumber: null, // billing no la publica; el ATS de ventas va agrupado y no la pide
      issueDate,
      partyIdentificationType: normalizeIdentificationType(customer?.identificationTypeCode),
      partyIdentification: trimTo(clean(customer?.identification), 20),
      partyName: trimTo(clean(customer?.businessName), 300),
      supportCode: null,
      paymentMethodCode: trimTo(clean(payload.paymentMethodCode), 2),
      currencyCode: payload.currencyCode || 'USD',
      totalCents: payload.totalCents,
      status: 'active',
      voidedAt: null,
      relatedSourceId: payload.relatedInvoiceId ?? null,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    const taxes = saleTaxes(id, payload);

    return retryOnUnique(() => inTransaction(this.deps.uow, async (uow) => {
      const existing = await uow.reportDocuments.findBySource(organizationId, 'billing', payload.invoiceId);
      if (existing) {
        if (existing.documentTypeCode !== UNKNOWN_DOCUMENT_TYPE) return { outcome: 'duplicate' };
        await fillGhost(uow, existing, document, taxes);
        return { outcome: 'updated', reason: 'la anulación llegó antes: se completó el comprobante y sigue anulado' };
      }
      await uow.reportDocuments.insert(document);
      await uow.reportDocuments.saveTaxes(taxes);
      return { outcome: 'created' };
    }));
  }
}

export class HandleInvoiceVoidedUseCase {
  constructor(private readonly deps: HandlerDeps) {}

  async execute(payload: InvoiceVoidedPayload): Promise<EventHandlerResult> {
    const { timezone, clock } = this.deps;
    const organizationId = payload.organizationId;
    if (!organizationId || !payload.invoiceId) return { outcome: 'skipped', reason: 'evento sin organización o sin id de comprobante' };

    const now = clock();
    const voidedAt = payload.voidedAt ? new Date(payload.voidedAt) : now;

    return retryOnUnique(() => inTransaction(this.deps.uow, async (uow) => {
      const existing = await uow.reportDocuments.findBySource(organizationId, 'billing', payload.invoiceId);
      if (existing) {
        if (existing.status === 'voided') return { outcome: 'duplicate' };
        await uow.reportDocuments.update({ ...existing, status: 'voided', voidedAt, updatedAt: now }, existing.version);
        return { outcome: 'updated' };
      }

      // La anulación llegó ANTES que el comprobante. El evento no dice de qué tipo era ni de quién: se deja constancia de que ese número
      // está anulado y, cuando llegue el comprobante, se completa sin reactivarlo.
      const parsed = parseDocumentNumber(payload.number);
      const issueDate = calendarDay(payload.issueDate, timezone) ?? calendarDay(voidedAt.toISOString(), timezone)!;
      const ghost: ReportDocument = {
        id: randomUUID(),
        organizationId,
        sourceService: 'billing',
        sourceId: payload.invoiceId,
        direction: 'sale',
        documentTypeCode: UNKNOWN_DOCUMENT_TYPE,
        establishment: parsed?.establishment ?? '000',
        emissionPoint: parsed?.emissionPoint ?? '000',
        sequential: parsed?.sequential ?? '000000000',
        authorizationNumber: null,
        issueDate,
        partyIdentificationType: null,
        partyIdentification: null,
        partyName: null,
        supportCode: null,
        paymentMethodCode: null,
        currencyCode: 'USD',
        totalCents: 0,
        status: 'voided',
        voidedAt,
        relatedSourceId: null,
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      await uow.reportDocuments.insert(ghost);
      return { outcome: 'created', reason: 'la anulación llegó antes que el comprobante: se dejó constancia' };
    }));
  }
}

// ── Compras ──────────────────────────────────────────────────────────────────

function purchaseDocument(payload: BillPostedPayload | BillVoidedPayload, parsed: NonNullable<ReturnType<typeof parseDocumentNumber>>, issueDate: string, now: Date, status: 'active' | 'voided', voidedAt: Date | null): ReportDocument {
  const supplier = payload.supplier;
  return {
    id: randomUUID(),
    organizationId: payload.organizationId,
    sourceService: 'purchasing',
    sourceId: payload.billId,
    direction: 'purchase',
    documentTypeCode: payload.docType || '01',
    establishment: parsed.establishment,
    emissionPoint: parsed.emissionPoint,
    sequential: parsed.sequential,
    authorizationNumber: trimTo(clean(payload.authorizationNumber), 49),
    issueDate,
    partyIdentificationType: normalizeIdentificationType(supplier?.identificationType),
    partyIdentification: trimTo(clean(supplier?.identification), 20),
    partyName: trimTo(clean(supplier?.legalName), 300),
    supportCode: trimTo(clean(payload.supportCode), 2),
    paymentMethodCode: trimTo(clean(payload.paymentMethodCode), 2),
    currencyCode: payload.currencyCode || 'USD',
    totalCents: payload.totalCents,
    status,
    voidedAt,
    relatedSourceId: null,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
}

export class HandleBillPostedUseCase {
  constructor(private readonly deps: HandlerDeps) {}

  async execute(payload: BillPostedPayload): Promise<EventHandlerResult> {
    const { timezone, clock } = this.deps;
    const organizationId = payload.organizationId;
    if (!organizationId || !payload.billId) return { outcome: 'skipped', reason: 'evento sin organización o sin id de factura' };
    const parsed = parseDocumentNumber(payload.supplierDocument);
    if (!parsed) return { outcome: 'skipped', reason: `número del documento del proveedor inválido: ${payload.supplierDocument}` };
    const issueDate = calendarDay(payload.issueDate, timezone);
    if (!issueDate) return { outcome: 'skipped', reason: 'la factura de compra no trae fecha de emisión' };

    const document = purchaseDocument(payload, parsed, issueDate, clock(), 'active', null);
    const taxes = purchaseTaxes(document.id, payload);

    return retryOnUnique(() => inTransaction(this.deps.uow, async (uow) => {
      const existing = await uow.reportDocuments.findBySource(organizationId, 'purchasing', payload.billId);
      if (existing) return { outcome: 'duplicate' };
      await uow.reportDocuments.insert(document);
      await uow.reportDocuments.saveTaxes(taxes);
      // Las retenciones que citaron esta factura ANTES de que existiera quedan enlazadas ahora.
      if (document.partyIdentification) {
        await uow.reportDocuments.linkWithholdingsToPurchase(organizationId, document.partyIdentification, parsed.full, payload.billId);
      }
      return { outcome: 'created' };
    }));
  }
}

export class HandleBillVoidedUseCase {
  constructor(private readonly deps: HandlerDeps) {}

  async execute(payload: BillVoidedPayload): Promise<EventHandlerResult> {
    const { timezone, clock } = this.deps;
    const organizationId = payload.organizationId;
    if (!organizationId || !payload.billId) return { outcome: 'skipped', reason: 'evento sin organización o sin id de factura' };

    const now = clock();
    return retryOnUnique(() => inTransaction(this.deps.uow, async (uow) => {
      const existing = await uow.reportDocuments.findBySource(organizationId, 'purchasing', payload.billId);
      if (existing) {
        if (existing.status === 'voided') return { outcome: 'duplicate' };
        await uow.reportDocuments.update({ ...existing, status: 'voided', voidedAt: now, updatedAt: now }, existing.version);
        return { outcome: 'updated' };
      }

      // La anulación llegó antes que la factura. A diferencia de ventas, este evento trae el documento completo: se guarda ya anulado
      // y la factura que llegue después no lo reactiva (`purchasing.bill.posted` encuentra el registro y lo trata como duplicado).
      const parsed = parseDocumentNumber(payload.supplierDocument);
      const issueDate = calendarDay(payload.issueDate, timezone);
      if (!parsed || !issueDate) return { outcome: 'skipped', reason: 'anulación de una factura de compra sin número o sin fecha' };
      const document = purchaseDocument(payload, parsed, issueDate, now, 'voided', now);
      await uow.reportDocuments.insert(document);
      await uow.reportDocuments.saveTaxes(purchaseTaxes(document.id, payload as BillPostedPayload));
      return { outcome: 'created', reason: 'la anulación llegó antes que la factura: se guardó anulada' };
    }));
  }
}

// ── Retenciones emitidas ─────────────────────────────────────────────────────

export class HandleWithholdingIssuedUseCase {
  constructor(private readonly deps: HandlerDeps) {}

  async execute(payload: WithholdingIssuedPayload): Promise<EventHandlerResult> {
    const { timezone, clock } = this.deps;
    const organizationId = payload.organizationId;
    if (!organizationId || !payload.withholdingId) return { outcome: 'skipped', reason: 'evento sin organización o sin id de retención' };

    const parsed = parseDocumentNumber(payload.number);
    if (!parsed) return { outcome: 'skipped', reason: `número de retención inválido: ${payload.number}` };
    const issueDate = calendarDay(payload.issueDate, timezone);
    if (!issueDate) return { outcome: 'skipped', reason: 'la retención no trae fecha de emisión' };
    // Sin el detalle por concepto no hay 103 posible. Es un evento anterior a los anexos: se avisa en vez de contar una retención en cero.
    if (!payload.lines?.length) return { outcome: 'skipped', reason: 'la retención no trae el detalle por concepto (evento anterior a los anexos del SRI)' };

    const supplier = payload.supplier;
    const identification = trimTo(clean(supplier?.identification), 20);
    const support = payload.support;
    const supportNumber = parseDocumentNumber(support?.number)?.full ?? null;
    const now = clock();
    const id = randomUUID();

    return retryOnUnique(() => inTransaction(this.deps.uow, async (uow) => {
      if (await uow.reportDocuments.findBySource(organizationId, 'fiscal', payload.withholdingId)) return { outcome: 'duplicate' };

      // Si la compra ya está registrada se enlaza; si llega después, `HandleBillPostedUseCase` enlaza las que quedaron esperando.
      const purchase = identification && supportNumber ? await uow.reportDocuments.findPurchaseBySupport(organizationId, identification, supportNumber) : null;

      const document: ReportDocument = {
        id,
        organizationId,
        sourceService: 'fiscal',
        sourceId: payload.withholdingId,
        direction: 'withholding_issued',
        documentTypeCode: '07',
        establishment: parsed.establishment,
        emissionPoint: parsed.emissionPoint,
        sequential: parsed.sequential,
        authorizationNumber: trimTo(clean(payload.authorizationNumber), 49),
        issueDate,
        partyIdentificationType: normalizeIdentificationType(supplier?.identificationType),
        partyIdentification: identification,
        partyName: trimTo(clean(supplier?.businessName), 300),
        supportCode: trimTo(clean(support?.supportCode), 2),
        paymentMethodCode: trimTo(clean(support?.paymentMethodCode), 2),
        currencyCode: payload.currencyCode || 'USD',
        totalCents: payload.totalWithheldCents,
        status: 'active',
        voidedAt: null,
        relatedSourceId: purchase?.sourceId ?? null,
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      await uow.reportDocuments.insert(document);

      const lines: ReportWithholdingLine[] = payload.lines!.map((line) => ({
        id: randomUUID(),
        documentId: id,
        tax: line.tax,
        conceptCode: line.retentionCode,
        ratePercent: line.ratePercent,
        baseCents: line.baseCents,
        amountCents: line.amountCents,
        supportsSourceId: purchase?.sourceId ?? null,
        supportDocumentNumber: supportNumber,
        supportPartyIdentification: identification,
      }));
      await uow.reportDocuments.saveWithholdingLines(lines);
      return { outcome: 'created' };
    }));
  }
}
