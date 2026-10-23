import { describe, expect, it } from 'vitest';
import { calculateAts, type DocDetail } from '../domain/ats.js';
import { calculateF103 } from '../domain/f103.js';
import { calculateF104 } from '../domain/f104.js';
import type { ReportDocument, ReportDocumentTax, ReportWithholdingLine } from '../domain/reporting.js';
import { CEDULA, ORG, RUC_SOCIEDAD } from './fixtures.js';

let n = 0;
const id = () => `id-${++n}`;

const doc = (over: Partial<ReportDocument> = {}): ReportDocument => ({
  id: id(), organizationId: ORG, sourceService: 'billing', sourceId: id(), direction: 'sale', documentTypeCode: '01',
  establishment: '001', emissionPoint: '001', sequential: String(n).padStart(9, '0'), authorizationNumber: null, issueDate: '2026-10-10',
  partyIdentificationType: '05', partyIdentification: CEDULA, partyName: 'Cliente', supportCode: null, paymentMethodCode: null, currencyCode: 'USD',
  totalCents: 0, status: 'active', voidedAt: null, relatedSourceId: null, createdAt: new Date(), updatedAt: new Date(), version: 1, ...over,
});

const iva = (documentId: string, ratePercent: number, baseCents: number, amountCents: number): ReportDocumentTax => ({ id: id(), documentId, kind: 'iva', taxCode: '2', ratePercent, baseCents, amountCents });
const line = (documentId: string, over: Partial<ReportWithholdingLine>): ReportWithholdingLine => ({
  id: id(), documentId, tax: 'income', conceptCode: '312', ratePercent: 1, baseCents: 0, amountCents: 0, supportsSourceId: null, supportDocumentNumber: null, supportPartyIdentification: null, ...over,
});

/** Una venta con su IVA: el total es base + IVA, así el desglose cuadra con el total del comprobante. */
function sale(type: string, parts: [number, number, number][], over: Partial<ReportDocument> = {}): DocDetail {
  const d = doc({ documentTypeCode: type, totalCents: parts.reduce((s, [, b, a]) => s + b + a, 0), ...over });
  return { document: d, taxes: parts.map(([rate, base, amount]) => iva(d.id, rate, base, amount)), lines: [] };
}

function purchase(parts: [number, number, number][], over: Partial<ReportDocument> = {}): DocDetail {
  const d = doc({
    direction: 'purchase', sourceService: 'purchasing', documentTypeCode: '01', partyIdentificationType: '04', partyIdentification: RUC_SOCIEDAD, partyName: 'Proveedor',
    authorizationNumber: '1209202601179001691900120020030000045671234567815', supportCode: '01', totalCents: parts.reduce((s, [, b, a]) => s + b + a, 0), ...over,
  });
  return { document: d, taxes: parts.map(([rate, base, amount]) => iva(d.id, rate, base, amount)), lines: [] };
}

function retention(lines: Partial<ReportWithholdingLine>[], over: Partial<ReportDocument> = {}): DocDetail {
  const d = doc({ direction: 'withholding_issued', sourceService: 'fiscal', documentTypeCode: '07', partyIdentificationType: '04', partyIdentification: RUC_SOCIEDAD, partyName: 'Proveedor', authorizationNumber: '1509202607179001691900110010010000000071234567818', ...over });
  return { document: d, taxes: [], lines: lines.map((l) => line(d.id, l)) };
}

describe('formulario 103', () => {
  it('agrupa SOLO la renta por código de concepto y suma bases y valores al centavo', () => {
    const result = calculateF103({
      period: '2026-10',
      retentions: [
        retention([{ conceptCode: '312', baseCents: 100_00, ratePercent: 1, amountCents: 1_00 }, { tax: 'vat', conceptCode: '1', baseCents: 15_00, ratePercent: 30, amountCents: 4_50 }]),
        retention([{ conceptCode: '312', baseCents: 200_00, ratePercent: 1, amountCents: 2_00 }, { conceptCode: '303', baseCents: 50_00, ratePercent: 10, amountCents: 5_00 }]),
      ],
    });
    const content = result.content as { totalesPorConcepto: Record<string, Record<string, unknown>>; retencionesIvaEIsdNoIncluidasCents: number };
    expect(Object.keys(content.totalesPorConcepto)).toEqual(['303', '312']);
    expect(content.totalesPorConcepto['312']).toMatchObject({ baseCents: 300_00, valorRetenidoCents: 3_00, retenciones: 2, porcentajes: [1], casillero: null });
    expect(content.totalesPorConcepto['303']).toMatchObject({ baseCents: 50_00, valorRetenidoCents: 5_00 });
    // La retención de IVA (concepto 1) NO es del 103: va al 104.
    expect(content.retencionesIvaEIsdNoIncluidasCents).toBe(4_50);
    expect(result.summary).toMatchObject({ conceptos: 2, retenciones: 2, totalBaseCents: 350_00, totalRetenidoCents: 8_00 });
  });

  it('un periodo sin retenciones da ceros, no un error', () => {
    const result = calculateF103({ period: '2026-10', retentions: [] });
    expect(result.summary).toMatchObject({ conceptos: 0, totalRetenidoCents: 0 });
    expect(result.findings).toEqual([]);
  });
});

describe('formulario 104', () => {
  const sales = () => [
    sale('01', [[15, 100_00, 15_00], [0, 20_00, 0]]),
    sale('01', [[15, 50_00, 7_50]]),
    sale('04', [[15, 10_00, 1_50]]), // nota de crédito: resta
    sale('05', [[15, 4_00, 60]]), // nota de débito: suma
  ];
  const purchases = () => [purchase([[15, 200_00, 30_00]]), purchase([[15, 40_00, 6_00]])];

  it('ventas por tarifa netas de notas de crédito (y con notas de débito sumando) y compras por tarifa', () => {
    const r = calculateF104({ period: '2026-10', sales: sales(), purchases: purchases(), retentions: [], manual: new Map() });
    const c = r.content as { ventas: { porTarifa: Record<string, { baseCents: number; ivaCents: number }>; ivaGeneradoNetoCents: number }; compras: { ivaCents: number } };
    // 15 %: 100 + 50 - 10 + 4 = 144 de base; 15 + 7,50 - 1,50 + 0,60 = 21,60 de IVA.
    expect(c.ventas.porTarifa['15']).toMatchObject({ baseCents: 144_00, ivaCents: 21_60 });
    expect(c.ventas.porTarifa['0']).toMatchObject({ baseCents: 20_00, ivaCents: 0 });
    expect(c.ventas.ivaGeneradoNetoCents).toBe(21_60);
    expect(c.compras.ivaCents).toBe(36_00);
  });

  it('SIN casilleros manuales el factor es 100 %: todo el IVA de compras es crédito (antes se aplicaba 1 %)', () => {
    const r = calculateF104({ period: '2026-10', sales: sales(), purchases: purchases(), retentions: [], manual: new Map() });
    const liq = (r.content as { liquidacion: Record<string, unknown> }).liquidacion;
    expect(liq).toMatchObject({ ivaGeneradoCents: 21_60, creditoAplicableCents: 36_00, saldoCents: -14_40, resultado: 'a_favor' });
  });

  it('con los casilleros del contador: factor 50 %, crédito anterior, IVA retenido por clientes y ajustes', () => {
    const manual = new Map([['factor_proporcionalidad_bps', 5_000], ['credito_anterior', 1_00], ['iva_retenido_sufrido', 2_00], ['ajustes', 50]]);
    const r = calculateF104({ period: '2026-10', sales: sales(), purchases: purchases(), retentions: [], manual });
    // 21,60 - (36,00 x 50 % = 18,00) - 1,00 - 2,00 + 0,50 = 1,10 a pagar
    expect((r.content as { liquidacion: Record<string, unknown> }).liquidacion).toMatchObject({ creditoAplicableCents: 18_00, saldoCents: 1_10, resultado: 'a_pagar' });
    expect((r.content as { camposManualesPendientes: string[] }).camposManualesPendientes).toEqual([]);
    expect(r.findings.some((f) => f.code === 'MANUAL_FIELDS_PENDING')).toBe(false);
  });

  it('avisa qué casilleros faltan por completar, porque cambian lo que se paga', () => {
    const r = calculateF104({ period: '2026-10', sales: sales(), purchases: purchases(), retentions: [], manual: new Map([['ajustes', 0]]) });
    const warn = r.findings.find((f) => f.code === 'MANUAL_FIELDS_PENDING');
    expect(warn?.severity).toBe('warning');
    expect(warn?.message).toContain('factor_proporcionalidad_bps');
    expect(warn?.message).not.toContain('ajustes,');
  });

  it('el IVA que NOSOTROS retuvimos a proveedores no se resta del crédito: se informa aparte', () => {
    const r = calculateF104({
      period: '2026-10', sales: sales(), purchases: purchases(), manual: new Map(),
      retentions: [retention([{ tax: 'vat', conceptCode: '1', baseCents: 30_00, ratePercent: 30, amountCents: 9_00 }, { conceptCode: '312', baseCents: 100_00, amountCents: 1_00 }])],
    });
    const c = r.content as { ivaRetenidoPracticadoCents: number; liquidacion: { saldoCents: number } };
    expect(c.ivaRetenidoPracticadoCents).toBe(9_00);
    expect(c.liquidacion.saldoCents).toBe(-14_40); // igual que sin la retención
  });

  it('no mezcla los importes con floats: miles de comprobantes de centavos impares suman exacto', () => {
    const many = Array.from({ length: 1000 }, () => sale('01', [[15, 33, 5]]));
    const r = calculateF104({ period: '2026-10', sales: many, purchases: [], retentions: [], manual: new Map() });
    expect((r.content as { ventas: { ivaGeneradoNetoCents: number } }).ventas.ivaGeneradoNetoCents).toBe(50_00);
  });
});

describe('ATS', () => {
  it('compras con sus retenciones, ventas agrupadas por cliente y tipo, y anulados', () => {
    const p = purchase([[15, 200_00, 30_00], [0, 10_00, 0]], { sourceId: 'bill-9', issueDate: '2026-10-05' });
    const r = retention([{ conceptCode: '312', baseCents: 210_00, ratePercent: 1.75, amountCents: 3_68 }], { relatedSourceId: 'bill-9' });
    const s1 = sale('01', [[15, 100_00, 15_00]]);
    const s2 = sale('01', [[15, 50_00, 7_50], [0, 5_00, 0]], { partyIdentification: s1.document.partyIdentification });
    const nc = sale('04', [[15, 10_00, 1_50]], { partyIdentification: s1.document.partyIdentification });
    const voided = sale('01', [[15, 99_00, 14_85]], { status: 'voided', voidedAt: new Date('2026-10-20T12:00:00Z') });

    const result = calculateAts({ period: '2026-10', informant: { ruc: RUC_SOCIEDAD, legalName: 'Mi Empresa' }, documents: [p, r, s1, s2, nc, voided] });
    const c = result.content as {
      compras: { base0Cents: number; baseGravadaCents: number; ivaCents: number; retenciones: { lineas: unknown[] }[] }[];
      ventasPorCliente: { tipoComprobante: string; comprobantes: number; baseGravadaCents: number; base0Cents: number; ivaCents: number }[];
      anulados: unknown[];
    };

    expect(c.compras).toHaveLength(1);
    expect(c.compras[0]).toMatchObject({ baseGravadaCents: 200_00, base0Cents: 10_00, ivaCents: 30_00 });
    expect(c.compras[0]!.retenciones).toHaveLength(1);

    // Una fila por cliente y tipo de comprobante: la nota de crédito va en SU fila, con importes positivos.
    expect(c.ventasPorCliente).toHaveLength(2);
    expect(c.ventasPorCliente.find((g) => g.tipoComprobante === '01')).toMatchObject({ comprobantes: 2, baseGravadaCents: 150_00, base0Cents: 5_00, ivaCents: 22_50 });
    expect(c.ventasPorCliente.find((g) => g.tipoComprobante === '04')).toMatchObject({ comprobantes: 1, baseGravadaCents: 10_00, ivaCents: 1_50 });
    expect(c.anulados).toHaveLength(1); // el anulado NO cuenta como venta
    expect(result.summary).toMatchObject({ compras: 1, comprobantesVenta: 3, anulados: 1, retencionesEmitidas: 1, retencionesSinCompra: 0 });
  });

  it('una retención sin compra en el sistema se lista aparte y avisa', () => {
    const r = retention([{ conceptCode: '312', baseCents: 100_00, amountCents: 1_75, supportDocumentNumber: '002-003-000004567' }]);
    const result = calculateAts({ period: '2026-10', informant: { ruc: RUC_SOCIEDAD, legalName: 'X' }, documents: [r] });
    expect((result.content as { retencionesSinCompra: { sustento: string }[] }).retencionesSinCompra[0]!.sustento).toBe('002-003-000004567');
    expect(result.findings.map((f) => f.code)).toContain('WITHHOLDING_WITHOUT_PURCHASE');
  });
});

describe('hallazgos', () => {
  const codes = (r: { findings: { code: string; severity: string }[] }) => r.findings.map((f) => `${f.severity}:${f.code}`);
  const run = (documents: DocDetail[], informant: { ruc: string; legalName: string } | null = { ruc: RUC_SOCIEDAD, legalName: 'X' }) => calculateAts({ period: '2026-10', informant, documents });

  it('un comprobante correcto NO genera ningún hallazgo de error (antes TODO documento salía con errores de total, de autorización y de nombre)', () => {
    const result = run([sale('01', [[15, 100_00, 15_00]]), purchase([[15, 200_00, 30_00]])]);
    expect(result.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('cédula con el verificador mal y compra sin autorización son errores; la compra sin sustento es advertencia', () => {
    const bad = sale('01', [[15, 100_00, 15_00]], { partyIdentification: '1710034066' });
    const noAuth = purchase([[15, 200_00, 30_00]], { authorizationNumber: null, supportCode: null });
    const found = codes(run([bad, noAuth]));
    expect(found).toContain('error:INVALID_PARTY_ID');
    expect(found).toContain('error:MISSING_AUTHORIZATION');
    expect(found).toContain('warning:MISSING_SUPPORT_CODE');
  });

  it('un RUC de sociedad con el verificador mal es solo advertencia (certeza baja)', () => {
    const doc = purchase([[15, 200_00, 30_00]], { partyIdentification: '1790016918001' });
    expect(codes(run([doc]))).toContain('warning:INVALID_PARTY_ID');
    expect(codes(run([doc]))).not.toContain('error:INVALID_PARTY_ID');
  });

  it('el mismo comprobante dos veces es error; el desglose que no suma el total es advertencia', () => {
    const a = purchase([[15, 200_00, 30_00]], { sequential: '000000500' });
    const b = purchase([[15, 200_00, 30_00]], { sequential: '000000500' });
    expect(codes(run([a, b]))).toContain('error:DUPLICATE_DOCUMENT');
    const off = purchase([[15, 200_00, 30_00]], { totalCents: 999_99 });
    expect(codes(run([off]))).toContain('warning:TAX_BASE_MISMATCH');
  });

  it('el consumidor final es válido sin dígito verificador y sin nombre', () => {
    const cf = sale('01', [[15, 10_00, 1_50]], { partyIdentificationType: '07', partyIdentification: '9999999999999', partyName: null });
    expect(run([cf]).findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('sin RUC de la organización el informante queda vacío y avisa', () => {
    expect(codes(run([], null))).toContain('warning:MISSING_INFORMANT');
  });
});
