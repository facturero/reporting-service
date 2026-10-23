import type { WithholdingLine } from './direct-documents.js';

/**
 * Evento billing.invoice.issued (publicado por billing-service).
 * Lleva: customerSnapshot (identificación, tipo, nombre), documentTypeCode, número, fecha, líneas con taxes[],
 * paymentMethodCode, posSaleId, relatedInvoiceId.
 */
export interface InvoiceIssuedPayload {
  invoiceId: string;
  customerId: string;
  number: string;
  sequentialNumber: string;
  issueDate: string | null;
  documentTypeCode: string;
  relatedInvoiceId: string | null;
  relatedIssueDate: string | null;
  creditNoteReason: string | null;
  posSaleId: string | null;
  paymentMethodCode: string | null;
  userId: string | undefined;
  organizationId: string;
  countryCode: string;
  establishmentId: string;
  emissionPointId: string;
  customerSnapshot: {
    id: string;
    businessName: string;
    identification: string | null;
    identificationTypeId: string | null;
    identificationTypeCode: string | null;
    email: string | null;
    phone: string | null;
    type: string;
  };
  issuerSnapshot: {
    legalName: string;
    tradeName: string | null;
    taxId: string;
    establishmentCode: string;
    emissionPointCode: string;
    address: string | null;
  };
  subtotalCents: number;
  taxTotalCents: number;
  totalCents: number;
  currencyCode: string;
  lines: {
    productId: string | null;
    productCode: string | null;
    description: string;
    quantity: number;
    unitPriceCents: number;
    discountCents: number;
    subtotalCents: number;
    taxes: { taxRateId: string; kind: string; rateSnapshot: string; baseCents: number; amountCents: number }[];
  }[];
}

/** billing.invoice.voided */
export interface InvoiceVoidedPayload {
  invoiceId: string;
  number: string;
  organizationId: string;
  issueDate: string | null;
  reason: string;
  voidedAt: string;
  userId: string | undefined;
}

/**
 * Evento purchasing.bill.posted (publicado por purchasing-service).
 * Lleva: authorizationNumber, supplier.identificationType, paymentMethodCode, supportCode,
 * y lines con taxBreakdown por tarifa.
 */
export interface BillPostedPayload {
  billId: string;
  internalNumber: string | null;
  supplierId: string;
  supplier: { identification: string; legalName: string; identificationType?: string | null } | null;
  docType: string | null;
  supplierDocument: string | null;
  issueDate: string | null;
  dueDate: string | null;
  currencyCode: string | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  voidReason: string | null;
  authorizationNumber?: string | null;
  paymentMethodCode?: string | null;
  supportCode?: string | null;
  taxBreakdown?: { taxCode: string; ratePercent: number; baseCents: number; amountCents: number }[];
  establishmentId?: string | null;
  orderId?: string | null;
  matchStatus?: string;
  organizationId: string;
  lines?: {
    kind: 'stock' | 'expense';
    productId: string | null;
    expenseAccountHint: string | null;
    subtotalCents: number;
    vatCents: number;
    iceCents: number;
    irbpnrCents: number;
    priceVarianceCents: number;
  }[];
}

/** purchasing.bill.voided */
export interface BillVoidedPayload {
  billId: string;
  internalNumber: string | null;
  supplierId: string;
  supplier: { identification: string; legalName: string; identificationType?: string | null } | null;
  docType: string | null;
  supplierDocument: string | null;
  issueDate: string | null;
  dueDate: string | null;
  currencyCode: string | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  voidReason: string | null;
  authorizationNumber?: string | null;
  paymentMethodCode?: string | null;
  supportCode?: string | null;
  establishmentId?: string | null;
  orderId?: string | null;
  matchStatus?: string;
  organizationId: string;
  lines?: {
    kind: 'stock' | 'expense';
    productId: string | null;
    expenseAccountHint: string | null;
    subtotalCents: number;
    vatCents: number;
    iceCents: number;
    irbpnrCents: number;
    priceVarianceCents: number;
  }[];
}

/**
 * Evento fiscal.ec.withholding.issued (publicado por fiscal-ecuador al autorizarse).
 * Lleva: lines[] con detalle por concepto, fiscalPeriod, supplier.identificationType,
 * support.supportCode, support.authorizationNumber, etc.
 */
export interface WithholdingIssuedPayload {
  withholdingId: string;
  fiscalInvoiceId: string;
  organizationId: string;
  number: string | null;
  issueDate: string | null;
  establishmentId: string;
  authorizationNumber: string | null;
  userId: string | undefined;
  currencyCode: string;
  supplier: { identification: string; businessName: string; identificationType?: string | null } | null;
  support: {
    documentCode: string | null;
    number: string | null;
    issueDate: string | null;
    supportCode?: string | null;
    authorizationNumber?: string | null;
    totalWithoutTaxesCents?: number;
    totalCents?: number;
    paymentMethodCode?: string | null;
    taxes?: { code: string; percentageCode: string; rate: number; baseCents: number; amountCents: number }[];
  } | null;
  fiscalPeriod?: string;
  lines?: WithholdingLine[];
  incomeTaxWithheldCents: number;
  vatWithheldCents: number;
  isdWithheldCents: number;
  totalWithheldCents: number;
}