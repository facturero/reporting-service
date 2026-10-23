import type { BillPostedPayload, BillVoidedPayload, InvoiceIssuedPayload, InvoiceVoidedPayload, WithholdingIssuedPayload } from '../domain/events.js';
import { MemoryDb } from './memory.js';
import {
  HandleBillPostedUseCase,
  HandleBillVoidedUseCase,
  HandleInvoiceIssuedUseCase,
  HandleInvoiceVoidedUseCase,
  HandleWithholdingIssuedUseCase,
} from '../application/use-cases/event-handlers.js';

export const ORG = '11111111-1111-4111-8111-111111111111';
export const ORG_B = '22222222-2222-4222-8222-222222222222';
export const USER = '33333333-3333-4333-8333-333333333333';
export const TZ = 'America/Guayaquil';

// Identificaciones REALES que pasan el algoritmo: cédula, RUC de sociedad privada (Corporación Favorita) y RUC de entidad pública (SRI).
export const CEDULA = '1710034065';
export const RUC_SOCIEDAD = '1790016919001';
export const RUC_PUBLICO = '1760013210001';

export function build(now = new Date('2026-10-25T15:00:00Z')) {
  const db = new MemoryDb();
  const deps = { uow: db, timezone: TZ, clock: () => now };
  return {
    db,
    deps,
    invoiceIssued: new HandleInvoiceIssuedUseCase(deps),
    invoiceVoided: new HandleInvoiceVoidedUseCase(deps),
    billPosted: new HandleBillPostedUseCase(deps),
    billVoided: new HandleBillVoidedUseCase(deps),
    withholdingIssued: new HandleWithholdingIssuedUseCase(deps),
  };
}

export const invoice = (over: Partial<InvoiceIssuedPayload> = {}): InvoiceIssuedPayload => ({
  invoiceId: 'inv-1',
  customerId: 'cus-1',
  number: '001-001-000000001',
  sequentialNumber: '000000001',
  // 2026-10-21T03:00Z son las 22:00 del 20 en Guayaquil: la factura es del día 20, no del 21.
  issueDate: '2026-10-21T03:00:00.000Z',
  documentTypeCode: '01',
  relatedInvoiceId: null,
  relatedIssueDate: null,
  creditNoteReason: null,
  posSaleId: null,
  paymentMethodCode: '01',
  userId: undefined,
  organizationId: ORG,
  countryCode: 'EC',
  establishmentId: 'est-1',
  emissionPointId: 'pt-1',
  customerSnapshot: { id: 'cus-1', businessName: 'Cliente Uno', identification: CEDULA, identificationTypeId: null, identificationTypeCode: '05', email: null, phone: null, type: 'person' },
  issuerSnapshot: { legalName: 'Mi Empresa', tradeName: null, taxId: RUC_SOCIEDAD, establishmentCode: '001', emissionPointCode: '001', address: null },
  subtotalCents: 100_00,
  taxTotalCents: 15_00,
  totalCents: 115_00,
  currencyCode: 'USD',
  lines: [
    {
      productId: 'p1', productCode: 'P1', description: 'Producto', quantity: 1, unitPriceCents: 100_00, discountCents: 0, subtotalCents: 100_00,
      taxes: [{ taxRateId: 'tr-15', kind: 'vat', rateSnapshot: '15.00', baseCents: 100_00, amountCents: 15_00 }],
    },
  ],
  ...over,
});

export const invoiceVoided = (over: Partial<InvoiceVoidedPayload> = {}): InvoiceVoidedPayload => ({
  invoiceId: 'inv-1',
  number: '001-001-000000001',
  organizationId: ORG,
  issueDate: '2026-10-21T03:00:00.000Z',
  reason: 'error',
  voidedAt: '2026-10-22T15:00:00.000Z',
  userId: undefined,
  ...over,
});

export const bill = (over: Partial<BillPostedPayload> = {}): BillPostedPayload => ({
  billId: 'bill-1',
  internalNumber: 'FC-2026-000001',
  supplierId: 'sup-1',
  supplier: { identification: RUC_SOCIEDAD, legalName: 'Distribuidora Andina', identificationType: 'RUC' },
  docType: '01',
  supplierDocument: '002-003-000004567',
  issueDate: '2026-10-12',
  dueDate: '2026-11-12',
  currencyCode: 'USD',
  subtotalCents: 200_00,
  taxCents: 30_00,
  totalCents: 230_00,
  voidReason: null,
  authorizationNumber: '1209202601179001691900120020030000045671234567815',
  paymentMethodCode: null,
  supportCode: null,
  taxBreakdown: [{ taxCode: '2', ratePercent: 15, baseCents: 200_00, amountCents: 30_00 }],
  organizationId: ORG,
  ...over,
});

export const billVoided = (over: Partial<BillVoidedPayload> = {}): BillVoidedPayload => ({
  billId: 'bill-1',
  internalNumber: 'FC-2026-000001',
  supplierId: 'sup-1',
  supplier: { identification: RUC_SOCIEDAD, legalName: 'Distribuidora Andina', identificationType: 'RUC' },
  docType: '01',
  supplierDocument: '002-003-000004567',
  issueDate: '2026-10-12',
  dueDate: '2026-11-12',
  currencyCode: 'USD',
  subtotalCents: 200_00,
  taxCents: 30_00,
  totalCents: 230_00,
  voidReason: 'duplicada',
  authorizationNumber: '1209202601179001691900120020030000045671234567815',
  organizationId: ORG,
  ...over,
});

export const withholding = (over: Partial<WithholdingIssuedPayload> = {}): WithholdingIssuedPayload => ({
  withholdingId: 'ret-1',
  fiscalInvoiceId: 'fis-1',
  organizationId: ORG,
  number: '001-001-000000007',
  issueDate: '2026-10-15T14:00:00.000Z',
  establishmentId: 'est-1',
  authorizationNumber: '1509202607179001691900110010010000000071234567818',
  userId: undefined,
  currencyCode: 'USD',
  fiscalPeriod: '10/2026',
  supplier: { identification: RUC_SOCIEDAD, businessName: 'Distribuidora Andina', identificationType: 'RUC' },
  support: { documentCode: '01', number: '002-003-000004567', issueDate: '2026-10-12', supportCode: '01', authorizationNumber: '1209202601179001691900120020030000045671234567815' },
  lines: [
    { tax: 'income', retentionCode: '312', baseCents: 200_00, ratePercent: 1.75, amountCents: 3_50 },
    { tax: 'vat', retentionCode: '1', baseCents: 30_00, ratePercent: 30, amountCents: 9_00 },
  ],
  incomeTaxWithheldCents: 3_50,
  vatWithheldCents: 9_00,
  isdWithheldCents: 0,
  totalWithheldCents: 12_50,
  ...over,
});
