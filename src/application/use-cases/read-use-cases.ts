import { NotFoundError } from '../../domain/errors.js';
import type { Page, ReadRepositories, ReportDocument, ReportDocumentFilters, TaxAnnexFinding, TaxAnnexRun, TaxAnnexRunFilters } from '../../domain/reporting.js';

export class ListRunsUseCase {
  constructor(private readonly repos: ReadRepositories) {}

  execute(organizationId: string, filters: TaxAnnexRunFilters): Promise<Page<TaxAnnexRun>> {
    return this.repos.taxAnnexRuns.list(organizationId, filters);
  }
}

export class ListDocumentsUseCase {
  constructor(private readonly repos: ReadRepositories) {}

  execute(organizationId: string, filters: ReportDocumentFilters): Promise<Page<ReportDocument>> {
    return this.repos.reportDocuments.list(organizationId, filters);
  }
}

export interface RunChange {
  key: string;
  previous: number;
  current: number;
  delta: number;
}

export interface RunDetail {
  run: TaxAnnexRun;
  findings: TaxAnnexFinding[];
  /** La versión inmediatamente anterior del mismo anexo y periodo, y qué cifras del resumen cambiaron respecto a ella. */
  previous: { id: string; version: number; generatedAt: Date } | null;
  changes: RunChange[];
  /** Cuántos hallazgos de cada severidad tenía esta versión y la anterior. */
  findingCounts: { errors: number; warnings: number; previousErrors: number | null; previousWarnings: number | null };
}

/** Cifras del resumen que cambiaron entre dos versiones: la forma barata y legible de ver qué movió una regeneración. */
export function diffSummaries(previous: unknown, current: unknown): RunChange[] {
  const a = (previous && typeof previous === 'object' ? previous : {}) as Record<string, unknown>;
  const b = (current && typeof current === 'object' ? current : {}) as Record<string, unknown>;
  const out: RunChange[] = [];
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const p = typeof a[key] === 'number' ? (a[key] as number) : 0;
    const c = typeof b[key] === 'number' ? (b[key] as number) : 0;
    if (p !== c) out.push({ key, previous: p, current: c, delta: c - p });
  }
  return out;
}

export class GetRunUseCase {
  constructor(private readonly repos: ReadRepositories) {}

  async execute(organizationId: string, id: string): Promise<RunDetail> {
    const run = await this.repos.taxAnnexRuns.findById(organizationId, id);
    if (!run) throw new NotFoundError('No existe esa versión del anexo.');
    const findings = await this.repos.taxAnnexRuns.listFindingsByRun(organizationId, run.id);
    const previousRun = run.version > 1 ? await this.repos.taxAnnexRuns.findByVersion(organizationId, run.annex, run.period, run.version - 1) : null;
    const previousFindings = previousRun ? await this.repos.taxAnnexRuns.listFindingsByRun(organizationId, previousRun.id) : null;
    const count = (list: TaxAnnexFinding[], severity: string) => list.filter((f) => f.severity === severity).length;
    return {
      run,
      findings,
      previous: previousRun ? { id: previousRun.id, version: previousRun.version, generatedAt: previousRun.generatedAt } : null,
      changes: previousRun ? diffSummaries(previousRun.summaryJson, run.summaryJson) : [],
      findingCounts: {
        errors: count(findings, 'error'),
        warnings: count(findings, 'warning'),
        previousErrors: previousFindings ? count(previousFindings, 'error') : null,
        previousWarnings: previousFindings ? count(previousFindings, 'warning') : null,
      },
    };
  }
}
