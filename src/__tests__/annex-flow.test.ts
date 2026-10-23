import { describe, expect, it } from 'vitest';
import type { AccountingCatalogPort, OrganizationCatalogPort, RoleMovement } from '../application/ports.js';
import { ExportRunUseCase } from '../application/use-cases/export-run.js';
import { GenerateAnnexUseCase } from '../application/use-cases/generate-annex.js';
import { GetReconciliationUseCase } from '../application/use-cases/get-reconciliation.js';
import { ListManualInputsUseCase, SetManualInputUseCase } from '../application/use-cases/manual-input-use-case.js';
import { GetRunUseCase, ListRunsUseCase } from '../application/use-cases/read-use-cases.js';
import { AnnexNotGeneratedError, AtsSchemaPendingError, CatalogUnavailableError, NotFoundError, ValidationError } from '../domain/errors.js';
import type { UnitOfWorkGateway } from '../domain/reporting.js';
import { bill, build, invoice, ORG, ORG_B, RUC_SOCIEDAD, USER, withholding } from './fixtures.js';
import { newId, UniqueError } from './memory.js';

const taxpayer = { ruc: RUC_SOCIEDAD, legalName: 'Mi Empresa S.A.' };

function setup(options: { accounting?: AccountingCatalogPort; organizations?: OrganizationCatalogPort } = {}) {
  const t = build();
  const organizations = options.organizations ?? { getTaxpayer: async () => taxpayer };
  const accounting = options.accounting ?? { getRoleMovements: async () => ({}) };
  const clock = () => new Date('2026-10-26T10:00:00Z');
  return {
    ...t,
    generate: new GenerateAnnexUseCase({ uow: t.db, organizations, clock }),
    getRun: new GetRunUseCase(t.db.reads),
    listRuns: new ListRunsUseCase(t.db.reads),
    exportRun: new ExportRunUseCase(t.db),
    reconcile: new GetReconciliationUseCase(t.db.reads, accounting),
    setManual: new SetManualInputUseCase({ uow: t.db, clock }),
    listManual: new ListManualInputsUseCase(t.db),
  };
}

/** Un mes con ventas, una nota de crédito, una compra con su retención y una venta anulada. */
async function loadOctober(t: ReturnType<typeof setup>) {
  await t.invoiceIssued.execute(invoice({ invoiceId: 'v1', number: '001-001-000000001', issueDate: '2026-10-10T15:00:00Z' }));
  await t.invoiceIssued.execute(invoice({
    invoiceId: 'v2', number: '001-001-000000002', issueDate: '2026-10-11T15:00:00Z', totalCents: 57_50,
    lines: [{ productId: 'p', productCode: 'P', description: 'x', quantity: 1, unitPriceCents: 50_00, discountCents: 0, subtotalCents: 50_00, taxes: [{ taxRateId: 't', kind: 'vat', rateSnapshot: '15.00', baseCents: 50_00, amountCents: 7_50 }] }],
  }));
  await t.invoiceIssued.execute(invoice({
    invoiceId: 'nc1', number: '001-001-000000003', documentTypeCode: '04', issueDate: '2026-10-12T15:00:00Z', totalCents: 11_50,
    lines: [{ productId: 'p', productCode: 'P', description: 'x', quantity: 1, unitPriceCents: 10_00, discountCents: 0, subtotalCents: 10_00, taxes: [{ taxRateId: 't', kind: 'vat', rateSnapshot: '15.00', baseCents: 10_00, amountCents: 1_50 }] }],
  }));
  await t.invoiceIssued.execute(invoice({ invoiceId: 'v4', number: '001-001-000000004', issueDate: '2026-10-13T15:00:00Z' }));
  await t.invoiceVoided.execute({ invoiceId: 'v4', number: '001-001-000000004', organizationId: ORG, issueDate: '2026-10-13T15:00:00Z', reason: 'error', voidedAt: '2026-10-14T15:00:00Z', userId: undefined });
  await t.billPosted.execute(bill());
  await t.withholdingIssued.execute(withholding());
}

describe('generar un anexo', () => {
  it('el 104 del mes cuadra: IVA de ventas netas, IVA de compras, saldo y retención practicada', async () => {
    const t = setup();
    await loadOctober(t);
    const { run, created } = await t.generate.execute(ORG, 'f104', '2026-10', USER);
    expect(created).toBe(true);
    expect(run).toMatchObject({ annex: 'f104', period: '2026-10', version: 1, generatedBy: USER });
    // Ventas: 15,00 + 7,50 - 1,50 (nota de crédito) = 21,00. La anulada NO cuenta. Compras: 30,00. Retención de IVA practicada: 9,00.
    expect(run.summaryJson).toMatchObject({ ivaGeneradoCents: 21_00, ivaComprasCents: 30_00, ivaRetenidoPracticadoCents: 9_00, saldoCents: 21_00 - 30_00 });
    expect(t.db.eventTypes()).toEqual(['reporting.tax_annex.generated']);
  });

  it('el 103 trae solo la renta; el ATS trae la compra con su retención enlazada y la venta anulada aparte', async () => {
    const t = setup();
    await loadOctober(t);
    const f103 = (await t.generate.execute(ORG, 'f103', '2026-10', USER)).run;
    expect(f103.summaryJson).toMatchObject({ conceptos: 1, totalBaseCents: 200_00, totalRetenidoCents: 3_50 });

    const ats = (await t.generate.execute(ORG, 'ats', '2026-10', USER)).run;
    const c = ats.contentJson as { informante: unknown; compras: { retenciones: unknown[] }[]; anulados: unknown[]; ventasPorCliente: { tipoComprobante: string; comprobantes: number }[] };
    expect(c.informante).toEqual(taxpayer);
    expect(c.compras[0]!.retenciones).toHaveLength(1);
    expect(c.anulados).toHaveLength(1);
    expect(c.ventasPorCliente.map((g) => `${g.tipoComprobante}x${g.comprobantes}`).sort()).toEqual(['01x2', '04x1']);
  });

  it('regenerar SIN cambios no crea otra versión; con un cambio crea la 2 y la 1 queda intacta', async () => {
    const t = setup();
    await loadOctober(t);
    const first = await t.generate.execute(ORG, 'f104', '2026-10', USER);
    const again = await t.generate.execute(ORG, 'f104', '2026-10', USER);
    expect(again.created).toBe(false);
    expect(again.run.id).toBe(first.run.id);
    expect(t.db.committed.runs).toHaveLength(1);

    await t.invoiceIssued.execute(invoice({ invoiceId: 'v9', number: '001-001-000000009', issueDate: '2026-10-20T15:00:00Z' }));
    const second = await t.generate.execute(ORG, 'f104', '2026-10', USER);
    expect(second.created).toBe(true);
    expect(second.run.version).toBe(2);
    expect(t.db.committed.runs.find((r) => r.id === first.run.id)!.summaryJson).toEqual(first.run.summaryJson); // inmutable
  });

  it('los hallazgos se GUARDAN con la versión (antes se calculaban y se perdían)', async () => {
    const t = setup();
    await loadOctober(t);
    const { run, findings } = await t.generate.execute(ORG, 'f104', '2026-10', USER);
    expect(findings.length).toBeGreaterThan(0);
    const stored = await t.db.reads.taxAnnexRuns.listFindingsByRun(ORG, run.id);
    expect(stored).toHaveLength(findings.length);
    expect(stored.map((f) => f.code)).toContain('MANUAL_FIELDS_PENDING');
    expect(await t.db.reads.taxAnnexRuns.listFindingsByRun(ORG_B, run.id)).toEqual([]); // otra organización no los ve
  });

  it('dos generaciones simultáneas del mismo periodo terminan en UNA versión (la que pierde la carrera encuentra la ganadora)', async () => {
    const t = setup();
    await loadOctober(t);
    let first = true;
    const racing: UnitOfWorkGateway = {
      begin: async (options) => {
        const uow = await t.db.begin(options);
        if (!first) return uow;
        first = false;
        return {
          ...uow,
          taxAnnexRuns: {
            ...uow.taxAnnexRuns,
            insert: async (run) => {
              // Otra petición confirma la MISMA versión justo antes; MySQL respondería con el UNIQUE.
              const rival = await t.db.begin();
              await rival.taxAnnexRuns.insert({ ...run, id: newId(), generatedBy: 'rival' });
              await rival.commit();
              throw new UniqueError('duplicado');
            },
          },
        };
      },
    };
    const generate = new GenerateAnnexUseCase({ uow: racing, organizations: { getTaxpayer: async () => taxpayer }, clock: () => new Date() });
    const result = await generate.execute(ORG, 'f104', '2026-10', USER);
    expect(t.db.committed.runs).toHaveLength(1);
    expect(result.created).toBe(false);
    expect(result.run.generatedBy).toBe('rival');
  });

  it('un periodo mal escrito se rechaza; uno sin documentos da un anexo en ceros', async () => {
    const t = setup();
    await expect(t.generate.execute(ORG, 'f104', '2026-13', USER)).rejects.toThrow(ValidationError);
    const { run } = await t.generate.execute(ORG, 'f104', '2026-09', USER);
    expect(run.summaryJson).toMatchObject({ ventas: 0, compras: 0, saldoCents: 0 });
  });

  it('los datos de una organización no entran al anexo de otra', async () => {
    const t = setup();
    await loadOctober(t);
    const { run } = await t.generate.execute(ORG_B, 'f104', '2026-10', USER);
    expect(run.summaryJson).toMatchObject({ ventas: 0, compras: 0 });
  });

  it('si no se puede leer la organización, el ATS NO se genera con el informante vacío', async () => {
    const t = setup({ organizations: { getTaxpayer: async () => { throw new CatalogUnavailableError(); } } });
    await expect(t.generate.execute(ORG, 'ats', '2026-10', USER)).rejects.toThrow(CatalogUnavailableError);
    expect(t.db.committed.runs).toHaveLength(0);
  });
});

describe('casilleros manuales', () => {
  it('cambian el 104 al regenerar, y el cambio queda en la bitácora con el valor anterior', async () => {
    const t = setup();
    await loadOctober(t);
    const before = (await t.generate.execute(ORG, 'f104', '2026-10', USER)).run;

    await t.setManual.execute({ organizationId: ORG, annex: 'f104', period: '2026-10', fieldCode: 'credito_anterior', amountCents: 5_00, setBy: USER });
    await t.setManual.execute({ organizationId: ORG, annex: 'f104', period: '2026-10', fieldCode: 'credito_anterior', amountCents: 8_00, setBy: USER });

    expect(t.db.committed.manual).toHaveLength(1); // el segundo reemplaza al primero (antes chocaba con el UNIQUE)
    const events = t.db.events.filter((e) => e.type === 'reporting.tax_annex.manual_input_set');
    expect(events.map((e) => (e.payload as { previousCents: number | null }).previousCents)).toEqual([null, 5_00]);

    const after = (await t.generate.execute(ORG, 'f104', '2026-10', USER)).run;
    expect(after.version).toBe(before.version + 1);
    expect((after.summaryJson as { saldoCents: number }).saldoCents).toBe((before.summaryJson as { saldoCents: number }).saldoCents - 8_00);
    expect((await t.listManual.execute(ORG, 'f104', '2026-10'))).toEqual([expect.objectContaining({ fieldCode: 'credito_anterior', amountCents: 8_00 })]);
  });

  it('rechaza casilleros que no existen y valores fuera de rango', async () => {
    const t = setup();
    await expect(t.setManual.execute({ organizationId: ORG, annex: 'f104', period: '2026-10', fieldCode: 'inventado', amountCents: 1, setBy: USER })).rejects.toThrow(ValidationError);
    await expect(t.setManual.execute({ organizationId: ORG, annex: 'f104', period: '2026-10', fieldCode: 'factor_proporcionalidad_bps', amountCents: 20_000, setBy: USER })).rejects.toThrow(ValidationError);
    expect(t.db.committed.manual).toHaveLength(0);
  });
});

describe('detalle de una versión', () => {
  it('muestra los hallazgos y qué cifras cambiaron respecto a la versión anterior', async () => {
    const t = setup();
    await loadOctober(t);
    const v1 = (await t.generate.execute(ORG, 'f104', '2026-10', USER)).run;
    await t.invoiceIssued.execute(invoice({ invoiceId: 'v9', number: '001-001-000000009', issueDate: '2026-10-20T15:00:00Z' }));
    const v2 = (await t.generate.execute(ORG, 'f104', '2026-10', USER)).run;

    const detail = await t.getRun.execute(ORG, v2.id);
    expect(detail.previous).toMatchObject({ id: v1.id, version: 1 });
    expect(detail.changes).toEqual(expect.arrayContaining([
      { key: 'ivaGeneradoCents', previous: 21_00, current: 36_00, delta: 15_00 },
      { key: 'ventas', previous: 3, current: 4, delta: 1 },
    ]));
    expect(detail.findings.length).toBe(detail.findingCounts.errors + detail.findingCounts.warnings);
    expect((await t.getRun.execute(ORG, v1.id)).previous).toBeNull();
    await expect(t.getRun.execute(ORG_B, v2.id)).rejects.toThrow(NotFoundError);
  });

  it('el listado trae las versiones más nuevas primero', async () => {
    const t = setup();
    await loadOctober(t);
    await t.generate.execute(ORG, 'f104', '2026-10', USER);
    await t.invoiceIssued.execute(invoice({ invoiceId: 'v9', number: '001-001-000000009', issueDate: '2026-10-20T15:00:00Z' }));
    await t.generate.execute(ORG, 'f104', '2026-10', USER);
    const page = await t.listRuns.execute(ORG, { period: '2026-10', page: 1, pageSize: 10 });
    expect(page.items.map((r) => r.version)).toEqual([2, 1]);
  });
});

describe('conciliación con contabilidad', () => {
  const movements = (over: Record<string, RoleMovement> = {}): AccountingCatalogPort => ({
    getRoleMovements: async () => ({
      vat_payable: { debitCents: 1_50, creditCents: 22_50 },
      vat_credit: { debitCents: 30_00, creditCents: 0 },
      vat_withholding_payable: { debitCents: 0, creditCents: 9_00 },
      income_tax_withholding_payable: { debitCents: 0, creditCents: 3_50 },
      ...over,
    }),
  });

  it('cuadra al centavo cuando el mayor dice lo mismo que el anexo', async () => {
    const t = setup({ accounting: movements() });
    await loadOctober(t);
    await t.generate.execute(ORG, 'f104', '2026-10', USER);
    const r = await t.reconcile.execute(ORG, 'f104', '2026-10');
    expect(r.status).toBe('ok');
    expect(r.items.map((i) => [i.code, i.annexCents, i.accountingCents, i.differenceCents])).toEqual([
      ['vat_generated', 21_00, 21_00, 0],
      ['vat_purchases', 30_00, 30_00, 0],
      ['vat_withheld', 9_00, 9_00, 0],
    ]);
  });

  it('muestra la diferencia cuando no cuadra, sin ocultarla ni ajustarla', async () => {
    const t = setup({ accounting: movements({ vat_credit: { debitCents: 28_00, creditCents: 0 } }) });
    await loadOctober(t);
    await t.generate.execute(ORG, 'f104', '2026-10', USER);
    const r = await t.reconcile.execute(ORG, 'f104', '2026-10');
    expect(r.status).toBe('mismatch');
    expect(r.items.find((i) => i.code === 'vat_purchases')).toMatchObject({ annexCents: 30_00, accountingCents: 28_00, differenceCents: 2_00 });
  });

  it('el 103 se compara con las retenciones de renta por pagar', async () => {
    const t = setup({ accounting: movements() });
    await loadOctober(t);
    await t.generate.execute(ORG, 'f103', '2026-10', USER);
    expect((await t.reconcile.execute(ORG, 'f103', '2026-10')).items).toEqual([expect.objectContaining({ role: 'income_tax_withholding_payable', annexCents: 3_50, accountingCents: 3_50, differenceCents: 0 })]);
  });

  it('sin contabilidad configurada no hay con qué comparar; si contabilidad no responde, es un error (no un cero)', async () => {
    const none = setup({ accounting: { getRoleMovements: async () => null } });
    await none.generate.execute(ORG, 'f104', '2026-10', USER);
    expect(await none.reconcile.execute(ORG, 'f104', '2026-10')).toMatchObject({ available: false, status: 'unavailable', items: [] });

    const down = setup({ accounting: { getRoleMovements: async () => { throw new CatalogUnavailableError(); } } });
    await down.generate.execute(ORG, 'f104', '2026-10', USER);
    await expect(down.reconcile.execute(ORG, 'f104', '2026-10')).rejects.toThrow(CatalogUnavailableError);
  });

  it('pide generar primero si todavía no hay una versión', async () => {
    const t = setup({ accounting: movements() });
    await expect(t.reconcile.execute(ORG, 'f104', '2026-10')).rejects.toThrow(AnnexNotGeneratedError);
  });
});

describe('exportar', () => {
  it('el CSV trae los importes con dos decimales y deja constancia en la bitácora', async () => {
    const t = setup();
    await loadOctober(t);
    const { run } = await t.generate.execute(ORG, 'f104', '2026-10', USER);
    const file = await t.exportRun.execute({ organizationId: ORG, runId: run.id, format: 'csv', exportedBy: USER });
    expect(file.fileName).toBe('F104_202610_v1.csv');
    expect(file.content).toContain('IVA generado en ventas,21.00');
    expect(file.content).toContain('SALDO A FAVOR,9.00'); // 21,00 de IVA de ventas contra 30,00 de crédito
    const exported = t.db.events.filter((e) => e.type === 'reporting.tax_annex.exported');
    expect(exported).toHaveLength(1);
    expect(exported[0]!.payload).toMatchObject({ runId: run.id, format: 'csv', exportedBy: USER, version: 1 });
  });

  it('el XML del ATS responde "esquema pendiente" y NO se inventa; en otros anexos el XML no existe', async () => {
    const t = setup();
    const ats = (await t.generate.execute(ORG, 'ats', '2026-10', USER)).run;
    await expect(t.exportRun.execute({ organizationId: ORG, runId: ats.id, format: 'xml', exportedBy: USER })).rejects.toThrow(AtsSchemaPendingError);
    const f103 = (await t.generate.execute(ORG, 'f103', '2026-10', USER)).run;
    await expect(t.exportRun.execute({ organizationId: ORG, runId: f103.id, format: 'xml', exportedBy: USER })).rejects.toThrow(ValidationError);
    expect(t.db.events.filter((e) => e.type === 'reporting.tax_annex.exported')).toHaveLength(0);
  });

  it('el CSV del ATS trae las cuatro tablas', async () => {
    const t = setup();
    await loadOctober(t);
    const { run } = await t.generate.execute(ORG, 'ats', '2026-10', USER);
    const csv = (await t.exportRun.execute({ organizationId: ORG, runId: run.id, format: 'csv', exportedBy: USER })).content;
    for (const section of ['COMPRAS', 'VENTAS POR CLIENTE Y TIPO DE COMPROBANTE', 'COMPROBANTES ANULADOS', 'RETENCIONES CUYA COMPRA NO ESTÁ EN EL SISTEMA']) expect(csv).toContain(section);
  });

  it('otra organización no puede exportar la versión', async () => {
    const t = setup();
    const { run } = await t.generate.execute(ORG, 'f103', '2026-10', USER);
    await expect(t.exportRun.execute({ organizationId: ORG_B, runId: run.id, format: 'csv', exportedBy: USER })).rejects.toThrow(NotFoundError);
  });
});
