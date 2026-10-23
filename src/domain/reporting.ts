import { randomUUID } from 'node:crypto';

export type AnnexType = 'ats' | 'f103' | 'f104';
export type SourceService = 'billing' | 'purchasing' | 'fiscal';
export type DocumentDirection = 'sale' | 'purchase' | 'withholding_issued';
export type DocumentStatus = 'active' | 'voided';
export type FindingSeverity = 'error' | 'warning';
export type TaxKind = 'iva' | 'ice' | 'irbpnr';
export type WithholdingTax = 'income' | 'vat' | 'isd';

/**
 * Código de tipo de comprobante de un documento cuyo tipo todavía no se conoce: nace así cuando la ANULACIÓN llega antes que el
 * comprobante (el evento de anulación de billing no dice de qué tipo era). Al llegar el comprobante se completa y conserva lo anulado.
 */
export const UNKNOWN_DOCUMENT_TYPE = '00';

export interface ReportDocument {
  id: string;
  organizationId: string;
  sourceService: SourceService;
  sourceId: string;
  direction: DocumentDirection;
  documentTypeCode: string;
  establishment: string;
  emissionPoint: string;
  sequential: string;
  authorizationNumber: string | null;
  /** Fecha de calendario `AAAA-MM-DD` (sin hora). */
  issueDate: string;
  partyIdentificationType: string | null;
  partyIdentification: string | null;
  partyName: string | null;
  supportCode: string | null;
  paymentMethodCode: string | null;
  currencyCode: string;
  totalCents: number;
  status: DocumentStatus;
  voidedAt: Date | null;
  /** Retención → id de la compra que sustenta. Compra/venta: nada (una orden de compra NO se guarda aquí). */
  relatedSourceId: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export interface ReportDocumentTax {
  id: string;
  documentId: string;
  kind: TaxKind;
  /** Código SRI del impuesto (tabla 16: 2 IVA, 3 ICE, 5 IRBPNR). */
  taxCode: string;
  ratePercent: number;
  baseCents: number;
  amountCents: number;
}

export interface ReportWithholdingLine {
  id: string;
  documentId: string;
  tax: WithholdingTax;
  /** Código de la tabla de retenciones del SRI (303, 312, 1, 9…). */
  conceptCode: string;
  ratePercent: number;
  baseCents: number;
  amountCents: number;
  supportsSourceId: string | null;
  /** `ddd-ddd-ddddddddd` del comprobante de compra que sustenta la retención. */
  supportDocumentNumber: string | null;
  supportPartyIdentification: string | null;
}

export interface TaxAnnexRun {
  id: string;
  organizationId: string;
  annex: AnnexType;
  period: string;
  version: number;
  contentHash: string;
  status: 'generated';
  generatedBy: string;
  generatedAt: Date;
  summaryJson: unknown;
  contentJson: unknown;
  xmlContent: string | null;
}

export interface TaxAnnexFinding {
  id: string;
  runId: string;
  severity: FindingSeverity;
  code: string;
  message: string;
  documentId: string | null;
}

export interface TaxAnnexManualInput {
  id: string;
  organizationId: string;
  annex: AnnexType;
  period: string;
  fieldCode: string;
  amountCents: number;
  setBy: string;
  setAt: Date;
}

export interface ReportDocumentFilters {
  /** Un solo comprobante: para llegar desde un hallazgo del anexo al documento al que apunta. */
  id?: string;
  sourceService?: SourceService;
  direction?: DocumentDirection;
  status?: DocumentStatus;
  from?: string;
  to?: string;
  q?: string;
  page: number;
  pageSize: number;
}

export interface TaxAnnexRunFilters {
  annex?: AnnexType;
  period?: string;
  page: number;
  pageSize: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DomainEvent {
  eventId: string;
  aggregateType: string;
  aggregateId: string;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

export function newDomainEvent(params: { type: string; aggregateType: string; aggregateId: string; payload: Record<string, unknown> }): DomainEvent {
  return { eventId: randomUUID(), aggregateType: params.aggregateType, aggregateId: params.aggregateId, type: params.type, payload: params.payload, occurredAt: new Date() };
}

/** Eventos que PUBLICA este servicio (ver asyncapi.yaml). */
export const REPORTING_EVENTS = {
  TAX_ANNEX_GENERATED: 'reporting.tax_annex.generated',
  TAX_ANNEX_EXPORTED: 'reporting.tax_annex.exported',
  TAX_ANNEX_MANUAL_INPUT_SET: 'reporting.tax_annex.manual_input_set',
} as const;

/** Eventos que CONSUME este servicio (ver asyncapi.yaml). */
export const CONSUMED_EVENTS = {
  BILLING_INVOICE_ISSUED: 'billing.invoice.issued',
  BILLING_INVOICE_VOIDED: 'billing.invoice.voided',
  PURCHASING_BILL_POSTED: 'purchasing.bill.posted',
  PURCHASING_BILL_VOIDED: 'purchasing.bill.voided',
  FISCAL_EC_WITHHOLDING_ISSUED: 'fiscal.ec.withholding.issued',
} as const;

// ── Puertos de repositorio ───────────────────────────────────────────────────

export interface ReportDocumentRepository {
  findById(organizationId: string, id: string): Promise<ReportDocument | null>;
  findBySource(organizationId: string, sourceService: SourceService, sourceId: string): Promise<ReportDocument | null>;
  /** La compra ACTIVA de ese proveedor con ese número `ddd-ddd-ddddddddd`. */
  findPurchaseBySupport(organizationId: string, identification: string, documentNumber: string): Promise<ReportDocument | null>;
  list(organizationId: string, filters: ReportDocumentFilters): Promise<Page<ReportDocument>>;
  /** Todos los documentos (activos y anulados) cuya fecha de emisión cae en el periodo `AAAA-MM`. */
  listByPeriod(organizationId: string, period: string): Promise<ReportDocument[]>;
  /** Alta. Lanza el UNIQUE de MySQL si (organización, servicio, id de origen) ya existe. */
  insert(document: ReportDocument): Promise<void>;
  /** Actualiza con control de versión: lanza `ConcurrentUpdateError` si otra operación lo cambió antes. Deja `version = esperada + 1`. */
  update(document: ReportDocument, expectedVersion: number): Promise<void>;
  saveTaxes(taxes: ReportDocumentTax[]): Promise<void>;
  saveWithholdingLines(lines: ReportWithholdingLine[]): Promise<void>;
  /** Solo de documentos de la organización. */
  listTaxesByDocuments(organizationId: string, documentIds: string[]): Promise<ReportDocumentTax[]>;
  listWithholdingLinesByDocuments(organizationId: string, documentIds: string[]): Promise<ReportWithholdingLine[]>;
  /**
   * Enlaza a la compra las retenciones que la citaban antes de que existiera (proveedor + número). Devuelve cuántas líneas enlazó.
   * Deja también `relatedSourceId` en los documentos de retención.
   */
  linkWithholdingsToPurchase(organizationId: string, identification: string, documentNumber: string, purchaseSourceId: string): Promise<number>;
}

export interface TaxAnnexRunRepository {
  findById(organizationId: string, id: string): Promise<TaxAnnexRun | null>;
  findLatestByPeriod(organizationId: string, annex: AnnexType, period: string): Promise<TaxAnnexRun | null>;
  findByVersion(organizationId: string, annex: AnnexType, period: string, version: number): Promise<TaxAnnexRun | null>;
  list(organizationId: string, filters: TaxAnnexRunFilters): Promise<Page<TaxAnnexRun>>;
  /** Alta. Lanza el UNIQUE si (organización, anexo, periodo, versión) ya existe: dos generaciones simultáneas no pisan la versión. */
  insert(run: TaxAnnexRun): Promise<void>;
  saveFindings(findings: TaxAnnexFinding[]): Promise<void>;
  listFindingsByRun(organizationId: string, runId: string): Promise<TaxAnnexFinding[]>;
}

export interface TaxAnnexManualInputRepository {
  list(organizationId: string, annex: AnnexType, period: string): Promise<TaxAnnexManualInput[]>;
  /** Crea o reemplaza el valor de ese casillero (único por organización, anexo, periodo y casillero). */
  upsert(input: TaxAnnexManualInput): Promise<void>;
}

export interface OutboxRepository {
  add(event: DomainEvent): Promise<void>;
}

export interface UnitOfWork {
  reportDocuments: ReportDocumentRepository;
  taxAnnexRuns: TaxAnnexRunRepository;
  taxAnnexManualInputs: TaxAnnexManualInputRepository;
  outbox: OutboxRepository;
}

/** Una unidad de trabajo abierta: se confirma o se deshace. */
export interface WriteUnitOfWork extends UnitOfWork {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface UnitOfWorkGateway {
  begin(options?: { readCommitted?: boolean }): Promise<WriteUnitOfWork>;
}

/** Los repositorios de solo lectura (fuera de transacción) para los listados y detalles. */
export type ReadRepositories = Pick<UnitOfWork, 'reportDocuments' | 'taxAnnexRuns' | 'taxAnnexManualInputs'>;

/** Payloads de eventos consumidos (re-exportados desde domain/events.ts). */
export type {
  InvoiceIssuedPayload,
  InvoiceVoidedPayload,
  BillPostedPayload,
  BillVoidedPayload,
  WithholdingIssuedPayload,
} from './events.js';
