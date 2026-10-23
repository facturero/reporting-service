import { randomUUID } from 'node:crypto';
import { Op, QueryTypes, Transaction } from 'sequelize';
import { withActor } from '@facturero/outbox-relay';
import { sequelize } from './sequelize.js';
import {
  OutboxModel,
  ReportDocumentModel,
  ReportDocumentTaxModel,
  ReportWithholdingLineModel,
  TaxAnnexFindingModel,
  TaxAnnexManualInputModel,
  TaxAnnexRunModel,
} from './models.js';
import { ConcurrentUpdateError } from '../../domain/errors.js';
import { periodEnd, periodStart } from '../../domain/dates.js';
import type {
  AnnexType,
  DomainEvent,
  Page,
  ReportDocument,
  ReportDocumentFilters,
  ReportDocumentTax,
  ReportWithholdingLine,
  SourceService,
  TaxAnnexFinding,
  TaxAnnexManualInput,
  TaxAnnexRun,
  TaxAnnexRunFilters,
  UnitOfWork,
  WriteUnitOfWork,
} from '../../domain/reporting.js';

// Los importes son BIGINT: mysql2 los devuelve como string cuando no caben en un número; los mapeos los pasan por Number().
// Cada repositorio recibe la transacción (o ninguna, para lecturas): una consulta sin ella correría FUERA de la unidad de trabajo.

const CHUNK = 500;
const chunks = <T>(items: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
};

// ── Documentos ───────────────────────────────────────────────────────────────

const toDocument = (m: ReportDocumentModel): ReportDocument => ({
  id: m.id,
  organizationId: m.organization_id,
  sourceService: m.source_service,
  sourceId: m.source_id,
  direction: m.direction,
  documentTypeCode: m.document_type_code,
  establishment: m.establishment,
  emissionPoint: m.emission_point,
  sequential: m.sequential,
  authorizationNumber: m.authorization_number,
  issueDate: String(m.issue_date),
  partyIdentificationType: m.party_identification_type,
  partyIdentification: m.party_identification,
  partyName: m.party_name,
  supportCode: m.support_code,
  paymentMethodCode: m.payment_method_code,
  currencyCode: m.currency_code,
  totalCents: Number(m.total_cents),
  status: m.status,
  voidedAt: m.voided_at,
  relatedSourceId: m.related_source_id,
  createdAt: m.created_at,
  updatedAt: m.updated_at,
  version: m.version,
});

const documentFields = (d: ReportDocument) => ({
  organization_id: d.organizationId,
  source_service: d.sourceService,
  source_id: d.sourceId,
  direction: d.direction,
  document_type_code: d.documentTypeCode,
  establishment: d.establishment,
  emission_point: d.emissionPoint,
  sequential: d.sequential,
  authorization_number: d.authorizationNumber,
  issue_date: d.issueDate,
  party_identification_type: d.partyIdentificationType,
  party_identification: d.partyIdentification,
  party_name: d.partyName,
  support_code: d.supportCode,
  payment_method_code: d.paymentMethodCode,
  currency_code: d.currencyCode,
  total_cents: d.totalCents,
  status: d.status,
  voided_at: d.voidedAt,
  related_source_id: d.relatedSourceId,
  updated_at: d.updatedAt,
});

const toTax = (r: Record<string, unknown>): ReportDocumentTax => ({
  id: String(r.id),
  documentId: String(r.document_id),
  kind: r.kind as ReportDocumentTax['kind'],
  taxCode: String(r.tax_code),
  ratePercent: Number(r.rate_percent),
  baseCents: Number(r.base_cents),
  amountCents: Number(r.amount_cents),
});

const toWithholdingLine = (r: Record<string, unknown>): ReportWithholdingLine => ({
  id: String(r.id),
  documentId: String(r.document_id),
  tax: r.tax as ReportWithholdingLine['tax'],
  conceptCode: String(r.concept_code),
  ratePercent: Number(r.rate_percent),
  baseCents: Number(r.base_cents),
  amountCents: Number(r.amount_cents),
  supportsSourceId: (r.supports_source_id as string | null) ?? null,
  supportDocumentNumber: (r.support_document_number as string | null) ?? null,
  supportPartyIdentification: (r.support_party_identification as string | null) ?? null,
});

function documentRepository(tx?: Transaction): UnitOfWork['reportDocuments'] {
  return {
    async findById(organizationId, id) {
      const row = await ReportDocumentModel.findOne({ where: { id, organization_id: organizationId }, transaction: tx });
      return row ? toDocument(row) : null;
    },

    async findBySource(organizationId, sourceService: SourceService, sourceId) {
      const row = await ReportDocumentModel.findOne({
        where: { organization_id: organizationId, source_service: sourceService, source_id: sourceId },
        transaction: tx,
      });
      return row ? toDocument(row) : null;
    },

    async findPurchaseBySupport(organizationId, identification, documentNumber) {
      const m = /^(\d{3})-(\d{3})-(\d{1,9})$/.exec(documentNumber);
      if (!m || !identification) return null;
      const row = await ReportDocumentModel.findOne({
        where: {
          organization_id: organizationId,
          source_service: 'purchasing',
          status: 'active',
          establishment: m[1],
          emission_point: m[2],
          sequential: m[3]!.padStart(9, '0'),
          party_identification: identification,
        },
        transaction: tx,
      });
      return row ? toDocument(row) : null;
    },

    async list(organizationId, filters: ReportDocumentFilters): Promise<Page<ReportDocument>> {
      const where: Record<string | symbol, unknown> = { organization_id: organizationId };
      if (filters.id) where.id = filters.id;
      if (filters.sourceService) where.source_service = filters.sourceService;
      if (filters.direction) where.direction = filters.direction;
      if (filters.status) where.status = filters.status;
      if (filters.from && filters.to) where.issue_date = { [Op.gte]: filters.from, [Op.lte]: filters.to };
      else if (filters.from) where.issue_date = { [Op.gte]: filters.from };
      else if (filters.to) where.issue_date = { [Op.lte]: filters.to };
      if (filters.q) {
        const like = `%${filters.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
        where[Op.or] = [{ party_name: { [Op.like]: like } }, { party_identification: { [Op.like]: like } }, { sequential: { [Op.like]: like } }];
      }
      const { count, rows } = await ReportDocumentModel.findAndCountAll({
        where,
        order: [['issue_date', 'DESC'], ['created_at', 'DESC']],
        limit: filters.pageSize,
        offset: (filters.page - 1) * filters.pageSize,
        transaction: tx,
      });
      return { items: rows.map(toDocument), total: count, page: filters.page, pageSize: filters.pageSize };
    },

    async listByPeriod(organizationId, period) {
      const rows = await ReportDocumentModel.findAll({
        where: { organization_id: organizationId, issue_date: { [Op.gte]: periodStart(period), [Op.lt]: periodEnd(period) } },
        order: [['issue_date', 'ASC'], ['establishment', 'ASC'], ['emission_point', 'ASC'], ['sequential', 'ASC'], ['id', 'ASC']],
        transaction: tx,
      });
      return rows.map(toDocument);
    },

    async insert(document) {
      await ReportDocumentModel.create({ id: document.id, ...documentFields(document), version: 1, created_at: document.createdAt } as never, { transaction: tx });
    },

    async update(document, expectedVersion) {
      const [affected] = await ReportDocumentModel.update(
        { ...documentFields(document), version: expectedVersion + 1 } as never,
        { where: { id: document.id, organization_id: document.organizationId, version: expectedVersion }, transaction: tx },
      );
      if (affected === 0) throw new ConcurrentUpdateError();
    },

    async saveTaxes(taxes) {
      if (taxes.length === 0) return;
      await ReportDocumentTaxModel.bulkCreate(
        taxes.map((t) => ({ id: t.id, document_id: t.documentId, kind: t.kind, tax_code: t.taxCode, rate_percent: t.ratePercent, base_cents: t.baseCents, amount_cents: t.amountCents })) as never,
        { transaction: tx },
      );
    },

    async saveWithholdingLines(lines) {
      if (lines.length === 0) return;
      await ReportWithholdingLineModel.bulkCreate(
        lines.map((l) => ({
          id: l.id,
          document_id: l.documentId,
          tax: l.tax,
          concept_code: l.conceptCode,
          rate_percent: l.ratePercent,
          base_cents: l.baseCents,
          amount_cents: l.amountCents,
          supports_source_id: l.supportsSourceId,
          support_document_number: l.supportDocumentNumber,
          support_party_identification: l.supportPartyIdentification,
        })) as never,
        { transaction: tx },
      );
    },

    async listTaxesByDocuments(organizationId, documentIds) {
      const out: ReportDocumentTax[] = [];
      for (const ids of chunks(documentIds)) {
        const rows = await sequelize.query<Record<string, unknown>>(
          `SELECT t.* FROM report_document_taxes t JOIN report_documents d ON d.id = t.document_id
           WHERE d.organization_id = :org AND t.document_id IN (:ids) ORDER BY t.id`,
          { replacements: { org: organizationId, ids }, type: QueryTypes.SELECT, transaction: tx },
        );
        out.push(...rows.map(toTax));
      }
      return out;
    },

    async listWithholdingLinesByDocuments(organizationId, documentIds) {
      const out: ReportWithholdingLine[] = [];
      for (const ids of chunks(documentIds)) {
        const rows = await sequelize.query<Record<string, unknown>>(
          `SELECT l.* FROM report_withholding_lines l JOIN report_documents d ON d.id = l.document_id
           WHERE d.organization_id = :org AND l.document_id IN (:ids) ORDER BY l.id`,
          { replacements: { org: organizationId, ids }, type: QueryTypes.SELECT, transaction: tx },
        );
        out.push(...rows.map(toWithholdingLine));
      }
      return out;
    },

    async linkWithholdingsToPurchase(organizationId, identification, documentNumber, purchaseSourceId) {
      // Una sola sentencia sobre las dos tablas: no hay ventana entre enlazar las líneas y marcar el documento.
      const [, meta] = await sequelize.query(
        `UPDATE report_withholding_lines l
           JOIN report_documents d ON d.id = l.document_id
            SET l.supports_source_id = :src, d.related_source_id = :src, d.updated_at = :now, d.version = d.version + 1
          WHERE d.organization_id = :org AND d.direction = 'withholding_issued'
            AND l.support_party_identification = :ident AND l.support_document_number = :num
            AND l.supports_source_id IS NULL`,
        { replacements: { src: purchaseSourceId, now: new Date(), org: organizationId, ident: identification, num: documentNumber }, transaction: tx },
      );
      return Number((meta as { affectedRows?: number } | undefined)?.affectedRows ?? 0);
    },
  };
}

// ── Corridas de anexos ───────────────────────────────────────────────────────

const toRun = (m: TaxAnnexRunModel): TaxAnnexRun => ({
  id: m.id,
  organizationId: m.organization_id,
  annex: m.annex,
  period: m.period,
  version: m.version,
  contentHash: m.content_hash,
  status: m.status,
  generatedBy: m.generated_by,
  generatedAt: m.generated_at,
  summaryJson: m.summary_json,
  contentJson: m.content_json,
  xmlContent: m.xml_content,
});

const toFinding = (m: TaxAnnexFindingModel): TaxAnnexFinding => ({
  id: m.id,
  runId: m.run_id,
  severity: m.severity,
  code: m.code,
  message: m.message,
  documentId: m.document_id,
});

function runRepository(tx?: Transaction): UnitOfWork['taxAnnexRuns'] {
  return {
    async findById(organizationId, id) {
      const row = await TaxAnnexRunModel.findOne({ where: { id, organization_id: organizationId }, transaction: tx });
      return row ? toRun(row) : null;
    },

    async findLatestByPeriod(organizationId, annex: AnnexType, period) {
      const row = await TaxAnnexRunModel.findOne({
        where: { organization_id: organizationId, annex, period },
        order: [['version', 'DESC']],
        transaction: tx,
      });
      return row ? toRun(row) : null;
    },

    async findByVersion(organizationId, annex: AnnexType, period, version) {
      const row = await TaxAnnexRunModel.findOne({ where: { organization_id: organizationId, annex, period, version }, transaction: tx });
      return row ? toRun(row) : null;
    },

    async list(organizationId, filters: TaxAnnexRunFilters): Promise<Page<TaxAnnexRun>> {
      const where: Record<string, unknown> = { organization_id: organizationId };
      if (filters.annex) where.annex = filters.annex;
      if (filters.period) where.period = filters.period;
      const { count, rows } = await TaxAnnexRunModel.findAndCountAll({
        where,
        order: [['period', 'DESC'], ['annex', 'ASC'], ['version', 'DESC']],
        limit: filters.pageSize,
        offset: (filters.page - 1) * filters.pageSize,
        transaction: tx,
      });
      return { items: rows.map(toRun), total: count, page: filters.page, pageSize: filters.pageSize };
    },

    async insert(run) {
      await TaxAnnexRunModel.create(
        {
          id: run.id,
          organization_id: run.organizationId,
          annex: run.annex,
          period: run.period,
          version: run.version,
          content_hash: run.contentHash,
          status: run.status,
          generated_by: run.generatedBy,
          generated_at: run.generatedAt,
          summary_json: run.summaryJson,
          content_json: run.contentJson,
          xml_content: run.xmlContent,
        } as never,
        { transaction: tx },
      );
    },

    async saveFindings(findings) {
      if (findings.length === 0) return;
      await TaxAnnexFindingModel.bulkCreate(
        findings.map((f) => ({ id: f.id, run_id: f.runId, severity: f.severity, code: f.code, message: f.message.slice(0, 500), document_id: f.documentId })) as never,
        { transaction: tx },
      );
    },

    async listFindingsByRun(organizationId, runId) {
      // Se comprueba que la corrida sea de la organización: los hallazgos no llevan organization_id propio.
      const run = await TaxAnnexRunModel.findOne({ where: { id: runId, organization_id: organizationId }, attributes: ['id'], transaction: tx });
      if (!run) return [];
      const rows = await TaxAnnexFindingModel.findAll({ where: { run_id: runId }, order: [['severity', 'ASC'], ['code', 'ASC'], ['id', 'ASC']], transaction: tx });
      return rows.map(toFinding);
    },
  };
}

// ── Casilleros manuales ──────────────────────────────────────────────────────

const toManual = (m: TaxAnnexManualInputModel): TaxAnnexManualInput => ({
  id: m.id,
  organizationId: m.organization_id,
  annex: m.annex,
  period: m.period,
  fieldCode: m.field_code,
  amountCents: Number(m.amount_cents),
  setBy: m.set_by,
  setAt: m.set_at,
});

function manualInputRepository(tx?: Transaction): UnitOfWork['taxAnnexManualInputs'] {
  return {
    async list(organizationId, annex, period) {
      const rows = await TaxAnnexManualInputModel.findAll({ where: { organization_id: organizationId, annex, period }, order: [['field_code', 'ASC']], transaction: tx });
      return rows.map(toManual);
    },

    async upsert(input) {
      const where = { organization_id: input.organizationId, annex: input.annex, period: input.period, field_code: input.fieldCode };
      const existing = await TaxAnnexManualInputModel.findOne({ where, transaction: tx, lock: tx ? Transaction.LOCK.UPDATE : undefined });
      if (existing) {
        await existing.update({ amount_cents: input.amountCents, set_by: input.setBy, set_at: input.setAt } as never, { transaction: tx });
        return;
      }
      await TaxAnnexManualInputModel.create(
        { id: input.id, ...where, amount_cents: input.amountCents, set_by: input.setBy, set_at: input.setAt } as never,
        { transaction: tx },
      );
    },
  };
}

// ── Outbox ───────────────────────────────────────────────────────────────────

function outboxRepository(tx?: Transaction): UnitOfWork['outbox'] {
  return {
    async add(event: DomainEvent) {
      await OutboxModel.create(
        {
          id: event.eventId,
          aggregate_type: event.aggregateType,
          aggregate_id: event.aggregateId,
          type: event.type,
          // El actor/IP/request-id viajan en el contexto de la petición para que la bitácora sepa QUIÉN hizo cada cosa.
          payload: withActor(event.payload),
          occurred_at: event.occurredAt,
          processed_at: null,
        } as never,
        { transaction: tx },
      );
    },
  };
}

// ── Unidad de trabajo ────────────────────────────────────────────────────────

export function buildRepositories(tx?: Transaction): UnitOfWork {
  return {
    reportDocuments: documentRepository(tx),
    taxAnnexRuns: runRepository(tx),
    taxAnnexManualInputs: manualInputRepository(tx),
    outbox: outboxRepository(tx),
  };
}

/** Lecturas fuera de transacción (listados y detalles). */
export const readOnlyRepositories = buildRepositories();

export class SequelizeUnitOfWork implements WriteUnitOfWork {
  readonly reportDocuments;
  readonly taxAnnexRuns;
  readonly taxAnnexManualInputs;
  readonly outbox;

  constructor(readonly tx: Transaction) {
    const repos = buildRepositories(tx);
    this.reportDocuments = repos.reportDocuments;
    this.taxAnnexRuns = repos.taxAnnexRuns;
    this.taxAnnexManualInputs = repos.taxAnnexManualInputs;
    this.outbox = repos.outbox;
  }

  async commit(): Promise<void> {
    await this.tx.commit();
  }

  async rollback(): Promise<void> {
    // MySQL deshace por su cuenta la transacción que pierde un interbloqueo; volver a deshacerla lanzaría un error que taparía el verdadero.
    if ((this.tx as unknown as { finished?: string }).finished) return;
    await this.tx.rollback();
  }
}

export class SequelizeUnitOfWorkFactory {
  constructor(private readonly onCommit?: (tx: Transaction) => void) {}

  async begin(options?: { readCommitted?: boolean }): Promise<SequelizeUnitOfWork> {
    const tx = await sequelize.transaction(options?.readCommitted ? { isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED } : undefined);
    // El relay publica el outbox justo tras el commit; sin este enganche los eventos esperan los 30 s del temporizador de respaldo.
    this.onCommit?.(tx);
    return new SequelizeUnitOfWork(tx);
  }
}

export const newId = () => randomUUID();
