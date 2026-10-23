import { Hono } from 'hono';
import { z } from 'zod';
import { manualFieldCodes } from '../../domain/manual-fields.js';
import type { GenerateAnnexUseCase } from '../../application/use-cases/generate-annex.js';
import type { ExportRunUseCase } from '../../application/use-cases/export-run.js';
import type { GetReconciliationUseCase } from '../../application/use-cases/get-reconciliation.js';
import type { ListManualInputsUseCase, SetManualInputUseCase } from '../../application/use-cases/manual-input-use-case.js';
import type { GetRunUseCase, ListDocumentsUseCase, ListRunsUseCase } from '../../application/use-cases/read-use-cases.js';
import { requireOrganization, requirePermission, requireUser } from './middlewares.js';
import { csvResponse, org, toFinding, toRunFull, toRunSummary, user, validate, type Vars } from './http-helpers.js';

export interface AppDependencies {
  corsOrigin: string;
  useCases: {
    listRuns: ListRunsUseCase;
    getRun: GetRunUseCase;
    generate: GenerateAnnexUseCase;
    exportRun: ExportRunUseCase;
    reconciliation: GetReconciliationUseCase;
    setManualInput: SetManualInputUseCase;
    listManualInputs: ListManualInputsUseCase;
    listDocuments: ListDocumentsUseCase;
  };
}

const annexParam = z.enum(['ats', 'f103', 'f104']);
const periodParam = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'El periodo debe ser AAAA-MM.');
const page = z.coerce.number().int().positive().default(1);
const pageSize = z.coerce.number().int().positive().max(100).default(20);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha debe ser AAAA-MM-DD.');

export function healthRoutes(): Hono {
  const r = new Hono();
  r.get('/health', (c) => c.json({ status: 'ok', service: 'reporting-service' }));
  return r;
}

/**
 * El gateway reenvía `/reporting/*` SIN quitar el prefijo, así que las rutas se sirven con él. Los permisos son finos a propósito:
 * quien consulta no tiene por qué poder generar una versión, ni quien genera descargar el archivo.
 */
export function annexRoutes(deps: AppDependencies): Hono<Vars> {
  const r = new Hono<Vars>();
  const { useCases: uc } = deps;
  const orgCtx = requireOrganization();

  r.get('/reporting/annexes/runs', orgCtx, requirePermission('tax_annex:read'),
    validate('query', z.object({ annex: annexParam.optional(), period: periodParam.optional(), page, pageSize })),
    async (c) => {
      const q = c.req.valid('query');
      const result = await uc.listRuns.execute(org(c), q);
      return c.json({ ...result, items: result.items.map(toRunSummary) });
    });

  r.post('/reporting/annexes/:annex/:period/generate', orgCtx, requireUser(), requirePermission('tax_annex:generate'),
    validate('param', z.object({ annex: annexParam, period: periodParam })),
    async (c) => {
      const { annex, period } = c.req.valid('param');
      const result = await uc.generate.execute(org(c), annex, period, user(c));
      // 201 = se creó una versión nueva; 200 = el contenido era idéntico al de la última y se devuelve esa.
      return c.json({ created: result.created, run: toRunFull(result.run), findings: result.findings.map(toFinding) }, result.created ? 201 : 200);
    });

  r.get('/reporting/annexes/runs/:id', orgCtx, requirePermission('tax_annex:read'),
    validate('param', z.object({ id: z.string().uuid() })),
    async (c) => {
      const detail = await uc.getRun.execute(org(c), c.req.valid('param').id);
      return c.json({
        run: toRunFull(detail.run),
        findings: detail.findings.map(toFinding),
        previous: detail.previous && { id: detail.previous.id, version: detail.previous.version, generatedAt: detail.previous.generatedAt.toISOString() },
        changes: detail.changes,
        findingCounts: detail.findingCounts,
      });
    });

  r.get('/reporting/annexes/runs/:id/export', orgCtx, requireUser(), requirePermission('tax_annex:export'),
    validate('param', z.object({ id: z.string().uuid() })),
    validate('query', z.object({ format: z.enum(['csv', 'xml']).default('csv') })),
    async (c) => {
      const file = await uc.exportRun.execute({ organizationId: org(c), runId: c.req.valid('param').id, format: c.req.valid('query').format, exportedBy: user(c) });
      return csvResponse(c, file);
    });

  r.get('/reporting/annexes/:annex/:period/reconciliation', orgCtx, requirePermission('tax_annex:read'),
    validate('param', z.object({ annex: annexParam, period: periodParam })),
    async (c) => {
      const { annex, period } = c.req.valid('param');
      return c.json(await uc.reconciliation.execute(org(c), annex, period));
    });

  r.get('/reporting/annexes/:annex/:period/manual-inputs', orgCtx, requirePermission('tax_annex:read'),
    validate('param', z.object({ annex: annexParam, period: periodParam })),
    async (c) => {
      const { annex, period } = c.req.valid('param');
      const saved = await uc.listManualInputs.execute(org(c), annex, period);
      return c.json({
        fields: manualFieldCodes(annex),
        items: saved.map((m) => ({ fieldCode: m.fieldCode, amountCents: m.amountCents, setBy: m.setBy, setAt: m.setAt.toISOString() })),
      });
    });

  r.put('/reporting/annexes/:annex/:period/manual-inputs/:fieldCode', orgCtx, requireUser(), requirePermission('tax_annex:generate'),
    validate('param', z.object({ annex: annexParam, period: periodParam, fieldCode: z.string().min(1).max(40) })),
    validate('json', z.object({ amountCents: z.number().int() }).strict()),
    async (c) => {
      const { annex, period, fieldCode } = c.req.valid('param');
      const { amountCents } = c.req.valid('json');
      const saved = await uc.setManualInput.execute({ organizationId: org(c), annex, period, fieldCode, amountCents, setBy: user(c) });
      // Cambiar un casillero no crea una versión: hay que generar de nuevo para que entre en el anexo.
      return c.json({ fieldCode: saved.fieldCode, amountCents: saved.amountCents, setBy: saved.setBy, setAt: saved.setAt.toISOString(), needsRegeneration: true });
    });

  r.get('/reporting/documents', orgCtx, requirePermission('tax_annex:read'),
    validate('query', z.object({
      id: z.string().uuid().optional(),
      sourceService: z.enum(['billing', 'purchasing', 'fiscal']).optional(),
      direction: z.enum(['sale', 'purchase', 'withholding_issued']).optional(),
      status: z.enum(['active', 'voided']).optional(),
      from: day.optional(),
      to: day.optional(),
      q: z.string().max(100).optional(),
      page,
      pageSize,
    })),
    async (c) => {
      const result = await uc.listDocuments.execute(org(c), c.req.valid('query'));
      return c.json({
        ...result,
        items: result.items.map((d) => ({
          id: d.id,
          sourceService: d.sourceService,
          direction: d.direction,
          documentTypeCode: d.documentTypeCode,
          number: `${d.establishment}-${d.emissionPoint}-${d.sequential}`,
          issueDate: d.issueDate,
          partyIdentification: d.partyIdentification,
          partyName: d.partyName,
          totalCents: d.totalCents,
          status: d.status,
        })),
      });
    });

  return r;
}
