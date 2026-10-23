import { describe, expect, it } from 'vitest';
import { HandleBillPostedUseCase, HandleInvoiceIssuedUseCase } from '../application/use-cases/event-handlers.js';
import type { UnitOfWorkGateway } from '../domain/reporting.js';
import { UniqueError } from './memory.js';
import { bill, billVoided, build, CEDULA, invoice, invoiceVoided, ORG, ORG_B, RUC_SOCIEDAD, withholding } from './fixtures.js';

describe('venta emitida (billing.invoice.issued)', () => {
  it('guarda el comprobante con la fecha de calendario de Guayaquil y SOLO el IVA en el desglose', async () => {
    const t = build();
    const payload = invoice();
    payload.lines[0]!.taxes.push({ taxRateId: 'x', kind: 'withholding_iva', rateSnapshot: '30.00', baseCents: 15_00, amountCents: 4_50 });
    expect(await t.invoiceIssued.execute(payload)).toMatchObject({ outcome: 'created' });

    const [doc] = t.db.committed.docs;
    expect(doc).toMatchObject({ direction: 'sale', documentTypeCode: '01', establishment: '001', emissionPoint: '001', sequential: '000000001', issueDate: '2026-10-20', partyIdentificationType: '05', partyIdentification: CEDULA, totalCents: 115_00, status: 'active' });
    // La retención de la línea (withholding_iva) no es IVA y no entra al desglose del 104.
    expect(t.db.committed.taxes).toEqual([expect.objectContaining({ kind: 'iva', taxCode: '2', ratePercent: 15, baseCents: 100_00, amountCents: 15_00, documentId: doc!.id })]);
  });

  it('el mismo evento dos veces no duplica el comprobante ni su desglose', async () => {
    const t = build();
    await t.invoiceIssued.execute(invoice());
    expect(await t.invoiceIssued.execute(invoice())).toEqual({ outcome: 'duplicate' });
    expect(t.db.committed.docs).toHaveLength(1);
    expect(t.db.committed.taxes).toHaveLength(1);
  });

  it('agrupa por tarifa las líneas del mismo comprobante', async () => {
    const t = build();
    const p = invoice();
    p.lines.push({ ...p.lines[0]!, taxes: [{ taxRateId: 'tr-15', kind: 'vat', rateSnapshot: '15.00', baseCents: 50_00, amountCents: 7_50 }] }, { ...p.lines[0]!, taxes: [{ taxRateId: 'tr-0', kind: 'vat', rateSnapshot: '0.00', baseCents: 20_00, amountCents: 0 }] });
    await t.invoiceIssued.execute(p);
    const byRate = Object.fromEntries(t.db.committed.taxes.map((x) => [x.ratePercent, x]));
    expect(byRate[15]).toMatchObject({ baseCents: 150_00, amountCents: 22_50 });
    expect(byRate[0]).toMatchObject({ baseCents: 20_00, amountCents: 0 });
  });

  it('no inventa lo que falta: sin fecha, sin tipo o con número inválido se omite', async () => {
    const t = build();
    expect(await t.invoiceIssued.execute(invoice({ issueDate: null }))).toMatchObject({ outcome: 'skipped', reason: expect.stringContaining('fecha') });
    expect(await t.invoiceIssued.execute(invoice({ documentTypeCode: '' }))).toMatchObject({ outcome: 'skipped' });
    expect(await t.invoiceIssued.execute(invoice({ number: 'FAC-1', sequentialNumber: '', issuerSnapshot: undefined as never }))).toMatchObject({ outcome: 'skipped' });
    expect(t.db.committed.docs).toHaveLength(0);
  });

  it('usa el establecimiento, punto y secuencial del emisor cuando el número no viene con guiones', async () => {
    const t = build();
    await t.invoiceIssued.execute(invoice({ number: '1', sequentialNumber: '000000045' }));
    expect(t.db.committed.docs[0]).toMatchObject({ establishment: '001', emissionPoint: '001', sequential: '000000045' });
  });
});

describe('venta anulada (billing.invoice.voided)', () => {
  it('anula el comprobante ya registrado', async () => {
    const t = build();
    await t.invoiceIssued.execute(invoice());
    expect(await t.invoiceVoided.execute(invoiceVoided())).toEqual({ outcome: 'updated' });
    expect(t.db.committed.docs[0]).toMatchObject({ status: 'voided', version: 2 });
    expect(t.db.committed.docs[0]!.voidedAt).toEqual(new Date('2026-10-22T15:00:00.000Z'));
    expect(await t.invoiceVoided.execute(invoiceVoided())).toEqual({ outcome: 'duplicate' });
  });

  it('si la anulación llega ANTES, queda constancia; al llegar el comprobante se completa y SIGUE anulado', async () => {
    const t = build();
    expect(await t.invoiceVoided.execute(invoiceVoided())).toMatchObject({ outcome: 'created' });
    expect(t.db.committed.docs[0]).toMatchObject({ documentTypeCode: '00', status: 'voided', establishment: '001', sequential: '000000001', totalCents: 0 });

    expect(await t.invoiceIssued.execute(invoice())).toMatchObject({ outcome: 'updated' });
    expect(t.db.committed.docs).toHaveLength(1);
    expect(t.db.committed.docs[0]).toMatchObject({ documentTypeCode: '01', status: 'voided', totalCents: 115_00, partyIdentification: CEDULA });
    expect(t.db.committed.taxes).toHaveLength(1);
    // Y un tercer envío del mismo comprobante ya es un duplicado.
    expect(await t.invoiceIssued.execute(invoice())).toEqual({ outcome: 'duplicate' });
    expect(t.db.committed.taxes).toHaveLength(1);
  });
});

describe('factura de compra (purchasing.bill.posted / voided)', () => {
  it('guarda la fecha tal cual (sin correrla un día), la autorización, el tipo de identificación en código SRI y el desglose por tarifa', async () => {
    const t = build();
    expect(await t.billPosted.execute(bill())).toEqual({ outcome: 'created' });
    expect(t.db.committed.docs[0]).toMatchObject({
      direction: 'purchase', issueDate: '2026-10-12', establishment: '002', emissionPoint: '003', sequential: '000004567',
      authorizationNumber: '1209202601179001691900120020030000045671234567815', partyIdentificationType: '04', partyIdentification: RUC_SOCIEDAD, relatedSourceId: null,
    });
    expect(t.db.committed.taxes).toEqual([expect.objectContaining({ kind: 'iva', taxCode: '2', ratePercent: 15, baseCents: 200_00, amountCents: 30_00 })]);
  });

  it('el ICE y el IRBPNR se guardan con su tipo, no como IVA', async () => {
    const t = build();
    await t.billPosted.execute(bill({ taxBreakdown: [{ taxCode: '2', ratePercent: 15, baseCents: 100_00, amountCents: 15_00 }, { taxCode: '3', ratePercent: 10, baseCents: 100_00, amountCents: 10_00 }, { taxCode: '5', ratePercent: 0, baseCents: 0, amountCents: 2_00 }] }));
    expect(t.db.committed.taxes.map((x) => x.kind).sort()).toEqual(['ice', 'irbpnr', 'iva']);
  });

  it('una compra sin desglose se guarda igual (el anexo avisará que falta) y es idempotente', async () => {
    const t = build();
    await t.billPosted.execute(bill({ taxBreakdown: undefined }));
    expect(await t.billPosted.execute(bill())).toEqual({ outcome: 'duplicate' });
    expect(t.db.committed.docs).toHaveLength(1);
    expect(t.db.committed.taxes).toHaveLength(0);
  });

  it('la anulación la marca; si llega ANTES se guarda ya anulada, y la factura que llegue después no la reactiva', async () => {
    const t = build();
    await t.billPosted.execute(bill());
    expect(await t.billVoided.execute(billVoided())).toEqual({ outcome: 'updated' });
    expect(t.db.committed.docs[0]!.status).toBe('voided');

    const early = build();
    expect(await early.billVoided.execute(billVoided())).toMatchObject({ outcome: 'created' });
    expect(early.db.committed.docs[0]).toMatchObject({ status: 'voided', totalCents: 230_00, documentTypeCode: '01' });
    expect(await early.billPosted.execute(bill())).toEqual({ outcome: 'duplicate' });
    expect(early.db.committed.docs[0]!.status).toBe('voided');
  });
});

describe('retención emitida (fiscal.ec.withholding.issued)', () => {
  it('guarda cada línea con su concepto, base, porcentaje y valor, y el comprobante que sustenta', async () => {
    const t = build();
    expect(await t.withholdingIssued.execute(withholding())).toEqual({ outcome: 'created' });
    expect(t.db.committed.docs[0]).toMatchObject({ direction: 'withholding_issued', documentTypeCode: '07', issueDate: '2026-10-15', sequential: '000000007', totalCents: 12_50, supportCode: '01' });
    expect(t.db.committed.lines).toEqual([
      expect.objectContaining({ tax: 'income', conceptCode: '312', baseCents: 200_00, ratePercent: 1.75, amountCents: 3_50, supportDocumentNumber: '002-003-000004567', supportPartyIdentification: RUC_SOCIEDAD, supportsSourceId: null }),
      expect.objectContaining({ tax: 'vat', conceptCode: '1', amountCents: 9_00 }),
    ]);
  });

  it('cuenta también las retenciones de compras hechas FUERA de Compras (cualquier tipo de sustento)', async () => {
    const t = build();
    expect(await t.withholdingIssued.execute(withholding({ support: { documentCode: '02', number: '009-009-000000123', issueDate: '2026-10-01' } }))).toEqual({ outcome: 'created' });
  });

  it('si la compra ya existe, queda enlazada; si no, queda esperando', async () => {
    const t = build();
    await t.billPosted.execute(bill());
    await t.withholdingIssued.execute(withholding());
    expect(t.db.committed.docs.find((d) => d.direction === 'withholding_issued')!.relatedSourceId).toBe('bill-1');
    expect(t.db.committed.lines.every((l) => l.supportsSourceId === 'bill-1')).toBe(true);
    // La compra NO se toca (antes se le pisaba su relatedSourceId).
    expect(t.db.committed.docs.find((d) => d.direction === 'purchase')!.relatedSourceId).toBeNull();
  });

  it('si la retención llega ANTES que la factura de compra, se enlaza cuando la factura llega', async () => {
    const t = build();
    await t.withholdingIssued.execute(withholding());
    expect(t.db.committed.docs[0]!.relatedSourceId).toBeNull();

    await t.billPosted.execute(bill());
    const ret = t.db.committed.docs.find((d) => d.direction === 'withholding_issued')!;
    expect(ret.relatedSourceId).toBe('bill-1');
    expect(t.db.committed.lines.every((l) => l.supportsSourceId === 'bill-1')).toBe(true);
  });

  it('no enlaza con la compra de OTRA organización ni de otro proveedor', async () => {
    const t = build();
    await t.billPosted.execute(bill({ organizationId: ORG_B }));
    await t.billPosted.execute(bill({ billId: 'bill-2', supplier: { identification: '1710034065001', legalName: 'Otro', identificationType: 'RUC' } }));
    await t.withholdingIssued.execute(withholding());
    expect(t.db.committed.docs.find((d) => d.direction === 'withholding_issued' && d.organizationId === ORG)!.relatedSourceId).toBeNull();
  });

  it('no cuenta una retención sin detalle por concepto (evento anterior a los anexos) ni la repite', async () => {
    const t = build();
    expect(await t.withholdingIssued.execute(withholding({ lines: undefined }))).toMatchObject({ outcome: 'skipped', reason: expect.stringContaining('detalle') });
    expect(t.db.committed.docs).toHaveLength(0);
    await t.withholdingIssued.execute(withholding());
    expect(await t.withholdingIssued.execute(withholding())).toEqual({ outcome: 'duplicate' });
    expect(t.db.committed.lines).toHaveLength(2);
  });
});

describe('transacciones y aislamiento', () => {
  it('si algo falla a mitad de camino NO queda nada a medias (ni el comprobante sin su desglose)', async () => {
    const t = build();
    t.db.beforeCommit = () => { throw new Error('se cayó la base'); };
    await expect(t.invoiceIssued.execute(invoice())).rejects.toThrow('se cayó la base');
    expect(t.db.committed.docs).toHaveLength(0);
    expect(t.db.committed.taxes).toHaveLength(0);
    // Y reintentar funciona: el evento se procesa completo.
    expect(await t.invoiceIssued.execute(invoice())).toEqual({ outcome: 'created' });
    expect(t.db.committed.taxes).toHaveLength(1);
  });

  it('el mismo número de comprobante en dos organizaciones son dos documentos', async () => {
    const t = build();
    await t.invoiceIssued.execute(invoice());
    await t.invoiceIssued.execute(invoice({ organizationId: ORG_B }));
    expect(t.db.committed.docs).toHaveLength(2);
  });
});

describe('eventos del MISMO documento procesados a la vez', () => {
  /** Un gateway cuya primera transacción pierde la carrera: justo antes de insertar, otro evento confirma el suyo y MySQL responde con el UNIQUE. */
  const losingRace = (t: ReturnType<typeof build>, rival: () => Promise<void>): UnitOfWorkGateway => {
    let first = true;
    return {
      begin: async (options) => {
        const uow = await t.db.begin(options);
        if (!first) return uow;
        first = false;
        return {
          ...uow,
          reportDocuments: {
            ...uow.reportDocuments,
            insert: async () => {
              await rival();
              throw new UniqueError('duplicado');
            },
          },
        };
      },
    };
  };

  // Regresión: con la anulación y la emisión procesándose en paralelo, la emisión chocaba con el comprobante provisional, se tomaba por
  // «duplicado» y los datos reales del comprobante se perdían: quedaba un anulado de tipo 00 y total 0 para siempre.
  it('la emisión que pierde contra el comprobante provisional de la anulación lo COMPLETA (no lo toma por duplicado)', async () => {
    const t = build();
    const racing = new HandleInvoiceIssuedUseCase({ ...t.deps, uow: losingRace(t, async () => { await t.invoiceVoided.execute(invoiceVoided()); }) });
    expect(await racing.execute(invoice())).toMatchObject({ outcome: 'updated' });
    expect(t.db.committed.docs).toHaveLength(1);
    expect(t.db.committed.docs[0]).toMatchObject({ documentTypeCode: '01', status: 'voided', totalCents: 115_00, partyIdentification: CEDULA });
    expect(t.db.committed.taxes).toHaveLength(1);
  });

  it('la misma factura de compra recibida dos veces a la vez queda una sola vez', async () => {
    const t = build();
    const racing = new HandleBillPostedUseCase({ ...t.deps, uow: losingRace(t, async () => { await t.billPosted.execute(bill()); }) });
    expect(await racing.execute(bill())).toEqual({ outcome: 'duplicate' });
    expect(t.db.committed.docs).toHaveLength(1);
    expect(t.db.committed.taxes).toHaveLength(1);
  });
});
