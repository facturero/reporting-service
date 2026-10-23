import { randomUUID } from 'node:crypto';
import { ConcurrentUpdateError } from '../domain/errors.js';
import { periodEnd, periodStart } from '../domain/dates.js';
import type {
  DomainEvent,
  Page,
  ReadRepositories,
  ReportDocument,
  ReportDocumentRepository,
  ReportDocumentTax,
  ReportWithholdingLine,
  TaxAnnexFinding,
  TaxAnnexManualInput,
  TaxAnnexManualInputRepository,
  TaxAnnexRun,
  TaxAnnexRunRepository,
  UnitOfWork,
  UnitOfWorkGateway,
  WriteUnitOfWork,
} from '../domain/reporting.js';

/** Lo que MySQL lanzaría ante un UNIQUE: el mismo nombre de error que reconoce `isUniqueViolation`. */
export class UniqueError extends Error {
  override name = 'SequelizeUniqueConstraintError';
}

export interface State {
  docs: ReportDocument[];
  taxes: ReportDocumentTax[];
  lines: ReportWithholdingLine[];
  runs: TaxAnnexRun[];
  findings: TaxAnnexFinding[];
  manual: TaxAnnexManualInput[];
  outbox: DomainEvent[];
}

const emptyState = (): State => ({ docs: [], taxes: [], lines: [], runs: [], findings: [], manual: [], outbox: [] });
const clone = <T>(v: T): T => structuredClone(v);

const paginate = <T>(items: T[], page: number, pageSize: number): Page<T> => ({ items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize });
const docNumber = (d: ReportDocument) => `${d.establishment}-${d.emissionPoint}-${d.sequential}`;

function documents(get: () => State): ReportDocumentRepository {
  return {
    async findById(org, id) { return get().docs.find((d) => d.organizationId === org && d.id === id) ?? null; },
    async findBySource(org, source, sourceId) { return get().docs.find((d) => d.organizationId === org && d.sourceService === source && d.sourceId === sourceId) ?? null; },
    async findPurchaseBySupport(org, identification, number) {
      return get().docs.find((d) => d.organizationId === org && d.sourceService === 'purchasing' && d.status === 'active' && d.partyIdentification === identification && docNumber(d) === number) ?? null;
    },
    async list(org, f) {
      let items = get().docs.filter((d) => d.organizationId === org);
      if (f.id) items = items.filter((d) => d.id === f.id);
      if (f.sourceService) items = items.filter((d) => d.sourceService === f.sourceService);
      if (f.direction) items = items.filter((d) => d.direction === f.direction);
      if (f.status) items = items.filter((d) => d.status === f.status);
      if (f.from) items = items.filter((d) => d.issueDate >= f.from!);
      if (f.to) items = items.filter((d) => d.issueDate <= f.to!);
      if (f.q) {
        const q = f.q.toLowerCase();
        items = items.filter((d) => (d.partyName ?? '').toLowerCase().includes(q) || (d.partyIdentification ?? '').includes(q) || d.sequential.includes(q));
      }
      items.sort((a, b) => b.issueDate.localeCompare(a.issueDate));
      return paginate(items, f.page, f.pageSize);
    },
    async listByPeriod(org, period) {
      return get().docs
        .filter((d) => d.organizationId === org && d.issueDate >= periodStart(period) && d.issueDate < periodEnd(period))
        .sort((a, b) => a.issueDate.localeCompare(b.issueDate) || docNumber(a).localeCompare(docNumber(b)) || a.id.localeCompare(b.id));
    },
    async insert(d) {
      const s = get();
      if (s.docs.some((x) => x.organizationId === d.organizationId && x.sourceService === d.sourceService && x.sourceId === d.sourceId)) throw new UniqueError('duplicado');
      s.docs.push({ ...d, version: 1 });
    },
    async update(d, expectedVersion) {
      const s = get();
      const i = s.docs.findIndex((x) => x.id === d.id && x.organizationId === d.organizationId && x.version === expectedVersion);
      if (i < 0) throw new ConcurrentUpdateError();
      s.docs[i] = { ...d, version: expectedVersion + 1 };
    },
    async saveTaxes(taxes) { get().taxes.push(...taxes.map((t) => ({ ...t }))); },
    async saveWithholdingLines(lines) { get().lines.push(...lines.map((l) => ({ ...l }))); },
    async listTaxesByDocuments(org, ids) {
      const mine = new Set(get().docs.filter((d) => d.organizationId === org).map((d) => d.id));
      return get().taxes.filter((t) => ids.includes(t.documentId) && mine.has(t.documentId));
    },
    async listWithholdingLinesByDocuments(org, ids) {
      const mine = new Set(get().docs.filter((d) => d.organizationId === org).map((d) => d.id));
      return get().lines.filter((l) => ids.includes(l.documentId) && mine.has(l.documentId));
    },
    async linkWithholdingsToPurchase(org, identification, number, purchaseSourceId) {
      const s = get();
      let linked = 0;
      for (const line of s.lines) {
        const doc = s.docs.find((d) => d.id === line.documentId);
        if (!doc || doc.organizationId !== org || doc.direction !== 'withholding_issued') continue;
        if (line.supportPartyIdentification !== identification || line.supportDocumentNumber !== number || line.supportsSourceId) continue;
        line.supportsSourceId = purchaseSourceId;
        doc.relatedSourceId = purchaseSourceId;
        doc.version += 1;
        linked += 1;
      }
      return linked;
    },
  };
}

function runs(get: () => State): TaxAnnexRunRepository {
  const mine = (org: string, annex: string, period: string) => get().runs.filter((r) => r.organizationId === org && r.annex === annex && r.period === period);
  return {
    async findById(org, id) { return get().runs.find((r) => r.organizationId === org && r.id === id) ?? null; },
    async findLatestByPeriod(org, annex, period) { return mine(org, annex, period).sort((a, b) => b.version - a.version)[0] ?? null; },
    async findByVersion(org, annex, period, version) { return mine(org, annex, period).find((r) => r.version === version) ?? null; },
    async list(org, f) {
      let items = get().runs.filter((r) => r.organizationId === org);
      if (f.annex) items = items.filter((r) => r.annex === f.annex);
      if (f.period) items = items.filter((r) => r.period === f.period);
      items.sort((a, b) => b.period.localeCompare(a.period) || a.annex.localeCompare(b.annex) || b.version - a.version);
      return paginate(items, f.page, f.pageSize);
    },
    async insert(r) {
      const s = get();
      if (s.runs.some((x) => x.organizationId === r.organizationId && x.annex === r.annex && x.period === r.period && x.version === r.version)) throw new UniqueError('versión duplicada');
      s.runs.push({ ...r });
    },
    async saveFindings(findings) { get().findings.push(...findings.map((f) => ({ ...f }))); },
    async listFindingsByRun(org, runId) {
      if (!get().runs.some((r) => r.organizationId === org && r.id === runId)) return [];
      return get().findings.filter((f) => f.runId === runId);
    },
  };
}

function manualInputs(get: () => State): TaxAnnexManualInputRepository {
  return {
    async list(org, annex, period) { return get().manual.filter((m) => m.organizationId === org && m.annex === annex && m.period === period).sort((a, b) => a.fieldCode.localeCompare(b.fieldCode)); },
    async upsert(input) {
      const s = get();
      const i = s.manual.findIndex((m) => m.organizationId === input.organizationId && m.annex === input.annex && m.period === input.period && m.fieldCode === input.fieldCode);
      if (i >= 0) s.manual[i] = { ...input, id: s.manual[i]!.id };
      else s.manual.push({ ...input });
    },
  };
}

function repos(get: () => State): UnitOfWork {
  return {
    reportDocuments: documents(get),
    taxAnnexRuns: runs(get),
    taxAnnexManualInputs: manualInputs(get),
    outbox: { async add(e) { get().outbox.push({ ...e }); } },
  };
}

/**
 * Base de datos en memoria con TRANSACCIONES de verdad: `begin()` trabaja sobre una copia y solo `commit()` la publica; `rollback()` la
 * descarta. Así las pruebas ven lo mismo que MySQL ante un error a mitad de camino (nada queda a medias).
 */
export class MemoryDb implements UnitOfWorkGateway {
  committed: State = emptyState();
  /** Lecturas fuera de transacción (lo ya confirmado). */
  readonly reads: ReadRepositories = repos(() => this.committed);
  /** Para simular una carrera: se ejecuta justo antes del siguiente `commit`. */
  beforeCommit: (() => void) | null = null;

  async begin(): Promise<WriteUnitOfWork> {
    let working = clone(this.committed);
    const unit = repos(() => working);
    return {
      ...unit,
      commit: async () => {
        const hook = this.beforeCommit;
        this.beforeCommit = null; // se consume aunque lance: un reintento no debe volver a fallar por el mismo gancho
        hook?.();
        this.committed = working;
      },
      rollback: async () => { working = clone(this.committed); },
    };
  }

  get events(): DomainEvent[] { return this.committed.outbox; }
  eventTypes(): string[] { return this.committed.outbox.map((e) => e.type); }
}

export const newId = () => randomUUID();
