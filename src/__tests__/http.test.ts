import { describe, expect, it } from 'vitest';
import { ExportRunUseCase } from '../application/use-cases/export-run.js';
import { GenerateAnnexUseCase } from '../application/use-cases/generate-annex.js';
import { GetReconciliationUseCase } from '../application/use-cases/get-reconciliation.js';
import { ListManualInputsUseCase, SetManualInputUseCase } from '../application/use-cases/manual-input-use-case.js';
import { GetRunUseCase, ListDocumentsUseCase, ListRunsUseCase } from '../application/use-cases/read-use-cases.js';
import { createApp } from '../interface/http/app.js';
import { bill, build, invoice, ORG, ORG_B, RUC_SOCIEDAD, USER, withholding } from './fixtures.js';

function setup() {
  const t = build();
  const clock = () => new Date('2026-10-26T10:00:00Z');
  const app = createApp({
    corsOrigin: '*',
    useCases: {
      listRuns: new ListRunsUseCase(t.db.reads),
      getRun: new GetRunUseCase(t.db.reads),
      generate: new GenerateAnnexUseCase({ uow: t.db, organizations: { getTaxpayer: async () => ({ ruc: RUC_SOCIEDAD, legalName: 'Mi Empresa' }) }, clock }),
      exportRun: new ExportRunUseCase(t.db),
      reconciliation: new GetReconciliationUseCase(t.db.reads, { getRoleMovements: async () => ({}) }),
      setManualInput: new SetManualInputUseCase({ uow: t.db, clock }),
      listManualInputs: new ListManualInputsUseCase(t.db),
      listDocuments: new ListDocumentsUseCase(t.db.reads),
    },
  });
  const ALL = 'tax_annex:read,tax_annex:generate,tax_annex:export';
  const call = (method: string, path: string, options: { perms?: string | null; org?: string | null; user?: string | null; body?: unknown } = {}) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.org !== null) headers['X-Organization-Id'] = options.org ?? ORG;
    if (options.user !== null) headers['X-User-Id'] = options.user ?? USER;
    if (options.perms !== null) headers['X-Permissions'] = options.perms ?? ALL;
    return app.request(path, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  };
  return { ...t, call };
}

describe('permisos y contexto', () => {
  it('sin organización es 401; sin permiso es 403; el de lectura no genera ni exporta', async () => {
    const t = setup();
    expect((await t.call('GET', '/reporting/annexes/runs', { org: null })).status).toBe(401);
    expect((await t.call('GET', '/reporting/annexes/runs', { perms: null })).status).toBe(403);
    expect((await t.call('POST', '/reporting/annexes/f104/2026-10/generate', { perms: 'tax_annex:read' })).status).toBe(403);
    expect((await t.call('GET', '/reporting/annexes/runs/00000000-0000-4000-8000-000000000000/export?format=csv', { perms: 'tax_annex:generate' })).status).toBe(403);
    expect((await t.call('PUT', '/reporting/annexes/f104/2026-10/manual-inputs/ajustes', { perms: 'tax_annex:read', body: { amountCents: 1 } })).status).toBe(403);
  });

  it('generar y exportar piden además un usuario identificado', async () => {
    const t = setup();
    expect((await t.call('POST', '/reporting/annexes/f104/2026-10/generate', { user: null })).status).toBe(401);
  });

  it('la salud no pide nada', async () => {
    const t = setup();
    expect((await t.call('GET', '/health', { org: null, perms: null, user: null })).status).toBe(200);
  });
});

describe('validación', () => {
  it('un periodo o un anexo mal escritos son 422 con el formato de error del servicio', async () => {
    const t = setup();
    const bad = await t.call('POST', '/reporting/annexes/f104/2026-13/generate');
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ code: 'VALIDATION_ERROR', details: [expect.objectContaining({ field: 'period' })] });
    expect((await t.call('POST', '/reporting/annexes/f999/2026-10/generate')).status).toBe(422);
    expect((await t.call('GET', '/reporting/annexes/runs/no-es-uuid')).status).toBe(422);
  });

  it('un casillero desconocido, un campo extra o un importe con decimales son 422', async () => {
    const t = setup();
    expect((await t.call('PUT', '/reporting/annexes/f104/2026-10/manual-inputs/inventado', { body: { amountCents: 1 } })).status).toBe(422);
    expect((await t.call('PUT', '/reporting/annexes/f104/2026-10/manual-inputs/ajustes', { body: { amountCents: 1, extra: true } })).status).toBe(422);
    expect((await t.call('PUT', '/reporting/annexes/f104/2026-10/manual-inputs/ajustes', { body: { amountCents: 1.5 } })).status).toBe(422);
  });

  it('un cuerpo que no es JSON es 400, no 500', async () => {
    const t = setup();
    const res = await t.call('PUT', '/reporting/annexes/f104/2026-10/manual-inputs/ajustes', {});
    expect([400, 422]).toContain(res.status);
  });
});

describe('recorrido completo', () => {
  it('genera (201), regenera sin cambios (200), lista sin arrastrar el contenido, y consulta el detalle', async () => {
    const t = setup();
    await t.invoiceIssued.execute(invoice({ issueDate: '2026-10-10T15:00:00Z' }));
    await t.billPosted.execute(bill());
    await t.withholdingIssued.execute(withholding());

    const first = await t.call('POST', '/reporting/annexes/f104/2026-10/generate');
    expect(first.status).toBe(201);
    const created = (await first.json()) as { created: boolean; run: { id: string; version: number; content: unknown }; findings: unknown[] };
    expect(created).toMatchObject({ created: true, run: { version: 1 } });
    expect(created.findings.length).toBeGreaterThan(0);

    const second = await t.call('POST', '/reporting/annexes/f104/2026-10/generate');
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ created: false, run: { id: created.run.id } });

    const list = (await (await t.call('GET', '/reporting/annexes/runs?period=2026-10')).json()) as { items: Record<string, unknown>[]; total: number };
    expect(list.total).toBe(1);
    expect(list.items[0]).toHaveProperty('summary');
    expect(list.items[0]).not.toHaveProperty('content');

    const detail = (await (await t.call('GET', `/reporting/annexes/runs/${created.run.id}`)).json()) as { run: { content: unknown }; findings: unknown[]; previous: unknown; changes: unknown[] };
    expect(detail.run.content).toBeTruthy();
    expect(detail.previous).toBeNull();
  });

  it('los documentos se listan y se filtran sin exponer ids de otras organizaciones', async () => {
    const t = setup();
    await t.invoiceIssued.execute(invoice());
    await t.invoiceIssued.execute(invoice({ organizationId: ORG_B }));
    const res = (await (await t.call('GET', '/reporting/documents?direction=sale')).json()) as { total: number; items: { number: string }[] };
    expect(res.total).toBe(1);
    expect(res.items[0]!.number).toBe('001-001-000000001');
  });

  it('un hallazgo lleva al comprobante: se filtra por su id y solo se ve el de la propia organización', async () => {
    const t = setup();
    await t.invoiceIssued.execute(invoice());
    await t.invoiceIssued.execute(invoice({ invoiceId: 'inv-2', number: '001-001-000000002' }));
    const all = (await (await t.call('GET', '/reporting/documents')).json()) as { items: { id: string }[] };
    expect(all.items).toHaveLength(2);
    const one = (await (await t.call('GET', `/reporting/documents?id=${all.items[0]!.id}`)).json()) as { total: number; items: { id: string }[] };
    expect(one.total).toBe(1);
    expect(one.items[0]!.id).toBe(all.items[0]!.id);
    expect(((await (await t.call('GET', `/reporting/documents?id=${all.items[0]!.id}`, { org: ORG_B })).json()) as { total: number }).total).toBe(0);
    expect((await t.call('GET', '/reporting/documents?id=no-es-uuid')).status).toBe(422);
  });

  it('otra organización recibe 404 al pedir una versión que no es suya', async () => {
    const t = setup();
    const created = (await (await t.call('POST', '/reporting/annexes/f103/2026-10/generate')).json()) as { run: { id: string } };
    const res = await t.call('GET', `/reporting/annexes/runs/${created.run.id}`, { org: ORG_B });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('exportación', () => {
  it('el CSV se descarga con BOM, tipo y nombre correctos y sin caché', async () => {
    const t = setup();
    const created = (await (await t.call('POST', '/reporting/annexes/f103/2026-10/generate')).json()) as { run: { id: string } };
    const res = await t.call('GET', `/reporting/annexes/runs/${created.run.id}/export?format=csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('F103_202610_v1.csv');
    expect(res.headers.get('cache-control')).toBe('no-store');
    // `text()` descarta el BOM al decodificar: se comprueban los bytes crudos (EF BB BF).
    expect([...new Uint8Array(await res.arrayBuffer()).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('el XML del ATS responde 501 ATS_SCHEMA_PENDING mientras no esté el esquema del SRI', async () => {
    const t = setup();
    const created = (await (await t.call('POST', '/reporting/annexes/ats/2026-10/generate')).json()) as { run: { id: string } };
    const res = await t.call('GET', `/reporting/annexes/runs/${created.run.id}/export?format=xml`);
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({ code: 'ATS_SCHEMA_PENDING' });
  });

  it('la conciliación de un anexo sin generar es 409 con su código', async () => {
    const t = setup();
    const res = await t.call('GET', '/reporting/annexes/f104/2026-10/reconciliation');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'ANNEX_NOT_GENERATED' });
  });
});

describe('casilleros manuales por HTTP', () => {
  it('se guardan, se listan y avisan que hay que regenerar', async () => {
    const t = setup();
    const put = await t.call('PUT', '/reporting/annexes/f104/2026-10/manual-inputs/credito_anterior', { body: { amountCents: 5_00 } });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ fieldCode: 'credito_anterior', amountCents: 5_00, needsRegeneration: true });
    const list = (await (await t.call('GET', '/reporting/annexes/f104/2026-10/manual-inputs')).json()) as { fields: string[]; items: { fieldCode: string }[] };
    expect(list.fields).toContain('factor_proporcionalidad_bps');
    expect(list.items.map((i) => i.fieldCode)).toEqual(['credito_anterior']);
  });
});
