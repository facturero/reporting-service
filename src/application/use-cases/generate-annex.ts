import { randomUUID } from 'node:crypto';
import { calculateAts, type DocDetail } from '../../domain/ats.js';
import { contentHash } from '../../domain/canonical.js';
import { ValidationError } from '../../domain/errors.js';
import { calculateF103 } from '../../domain/f103.js';
import { calculateF104 } from '../../domain/f104.js';
import type { Finding } from '../../domain/findings.js';
import type { AnnexType, TaxAnnexFinding, TaxAnnexRun, UnitOfWork, UnitOfWorkGateway } from '../../domain/reporting.js';
import { taxAnnexGeneratedEvent } from '../events.js';
import type { Clock, OrganizationCatalogPort } from '../ports.js';
import { inTransaction, isUniqueViolation } from './transaction.js';

export interface GenerateAnnexDeps {
  uow: UnitOfWorkGateway;
  organizations: OrganizationCatalogPort;
  clock: Clock;
}

export interface GenerateResult {
  run: TaxAnnexRun;
  findings: TaxAnnexFinding[];
  /** `false` si el contenido es idéntico al de la última versión y por eso NO se creó otra. */
  created: boolean;
}

const MAX_ATTEMPTS = 3;

/** Todos los documentos del periodo con su desglose de impuestos y sus líneas de retención. */
async function loadDetails(uow: UnitOfWork, organizationId: string, period: string): Promise<DocDetail[]> {
  const documents = await uow.reportDocuments.listByPeriod(organizationId, period);
  const ids = documents.map((d) => d.id);
  const [taxes, lines] = await Promise.all([
    uow.reportDocuments.listTaxesByDocuments(organizationId, ids),
    uow.reportDocuments.listWithholdingLinesByDocuments(organizationId, ids),
  ]);
  return documents.map((document) => ({
    document,
    taxes: taxes.filter((t) => t.documentId === document.id),
    lines: lines.filter((l) => l.documentId === document.id),
  }));
}

export class GenerateAnnexUseCase {
  constructor(private readonly deps: GenerateAnnexDeps) {}

  /**
   * Calcula el anexo del periodo y lo guarda como una VERSIÓN nueva e inmutable. Si el contenido es idéntico al de la última versión no
   * se crea otra (regenerar sin cambios no ensucia el historial). Dos generaciones simultáneas del mismo periodo terminan en UNA sola
   * versión: la que pierde la carrera choca con el UNIQUE, vuelve a leer y encuentra el contenido ya guardado.
   */
  async execute(organizationId: string, annex: AnnexType, period: string, generatedBy: string): Promise<GenerateResult> {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new ValidationError([{ field: 'period', message: 'El periodo debe ser AAAA-MM.' }]);

    // Se consulta fuera de la transacción: no hay por qué sostener una conexión de base de datos mientras otro servicio responde.
    const informant = annex === 'ats' ? await this.deps.organizations.getTaxpayer(organizationId) : null;

    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.once(organizationId, annex, period, generatedBy, informant);
      } catch (err) {
        if (isUniqueViolation(err) && attempt < MAX_ATTEMPTS) continue;
        throw err;
      }
    }
  }

  private once(organizationId: string, annex: AnnexType, period: string, generatedBy: string, informant: Awaited<ReturnType<OrganizationCatalogPort['getTaxpayer']>>): Promise<GenerateResult> {
    // READ COMMITTED: la lectura de los documentos no bloquea a los manejadores de eventos que siguen escribiendo.
    return inTransaction(
      this.deps.uow,
      async (uow) => {
        const details = await loadDetails(uow, organizationId, period);
        const manual = new Map((await uow.taxAnnexManualInputs.list(organizationId, annex, period)).map((m) => [m.fieldCode, m.amountCents]));
        const active = (direction: string) => details.filter((d) => d.document.direction === direction && d.document.status === 'active');

        let result: { content: unknown; summary: unknown; findings: Finding[] };
        if (annex === 'ats') result = calculateAts({ period, documents: details, informant });
        else if (annex === 'f103') result = calculateF103({ period, retentions: active('withholding_issued') });
        else result = calculateF104({ period, sales: active('sale'), purchases: active('purchase'), retentions: active('withholding_issued'), manual });

        const hash = contentHash({ content: result.content, findings: result.findings });
        const latest = await uow.taxAnnexRuns.findLatestByPeriod(organizationId, annex, period);
        if (latest && latest.contentHash === hash) {
          return { run: latest, findings: await uow.taxAnnexRuns.listFindingsByRun(organizationId, latest.id), created: false };
        }

        const run: TaxAnnexRun = {
          id: randomUUID(),
          organizationId,
          annex,
          period,
          version: (latest?.version ?? 0) + 1,
          contentHash: hash,
          status: 'generated',
          generatedBy,
          generatedAt: this.deps.clock(),
          summaryJson: result.summary,
          contentJson: result.content,
          xmlContent: null,
        };
        await uow.taxAnnexRuns.insert(run);
        const findings: TaxAnnexFinding[] = result.findings.map((f) => ({ id: randomUUID(), runId: run.id, severity: f.severity, code: f.code, message: f.message, documentId: f.documentId }));
        await uow.taxAnnexRuns.saveFindings(findings);
        await uow.outbox.add(taxAnnexGeneratedEvent({ run, triggeredBy: generatedBy, errors: findings.filter((f) => f.severity === 'error').length, warnings: findings.filter((f) => f.severity === 'warning').length }));
        return { run, findings, created: true };
      },
      { readCommitted: true },
    );
  }
}
