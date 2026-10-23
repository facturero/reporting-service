// Verificación de los ANEXOS DEL SRI contra MySQL y RabbitMQ REALES, con contabilidad real asentando los MISMOS eventos.
//
//   1. mysql (3307) y rabbitmq arriba; reporting_db migrada       cd backend/reporting-service && DB_HOST=127.0.0.1 DB_PORT=3307 DB_USER=root DB_PASSWORD=root123 DB_NAME=reporting_db npx sequelize-cli db:migrate
//   2. contabilidad (:3016) y reporting (:3019) desde el árbol    (ver bash scripts/local-stack/arrancar-arbol.sh servicios; reporting con ACCOUNTING_SERVICE_URL=http://127.0.0.1:3016
//                                                                  y ORGANIZATION_SERVICE_URL=http://127.0.0.1:3002, que este script atiende con un servicio de mentira)
//   3. node scripts/verify-annexes.mjs
//
// Usa una organización NUEVA en cada corrida (no mezcla con datos de otras pruebas) y publica los eventos como lo hace el outbox-relay.
//
// Qué comprueba que ninguna prueba unitaria (repositorios en memoria) puede ver:
//   · el SQL real: que el desglose de impuestos y las líneas de retención se GUARDAN, y que las columnas se llenan de verdad;
//   · diez generaciones simultáneas del mismo periodo: exactamente UNA versión;
//   · el mismo comprobante en tres mensajes, la anulación antes que el comprobante, la retención antes que la compra;
//   · LA PRUEBA DE ORO: lo que dicen el 103 y el 104 es EXACTAMENTE lo que dice el libro mayor para el mismo periodo (IVA de ventas, IVA de
//     compras, IVA y renta retenidos), leído por SQL directo a las tablas de contabilidad, y la conciliación del servicio coincide;
//   · el aislamiento por organización, los permisos y la descarga (CSV con BOM; el XML del ATS responde 501).
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import http from 'node:http';

const amqp = createRequire(new URL('../node_modules/@facturero/outbox-relay/package.json', import.meta.url))('amqplib');

const REPORTING = process.env.REPORTING ?? 'http://127.0.0.1:3019';
const ACCOUNTING = process.env.ACCOUNTING ?? 'http://127.0.0.1:3016';
const AMQP = process.env.AMQP ?? 'amqp://127.0.0.1:5672';
const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const USER = randomUUID();
const ALL = 'tax_annex:read,tax_annex:generate,tax_annex:export';
const ACC_PERMS = 'account:read,account:manage,journal:read,journal:create,journal:post,journal:reverse,period:manage,ledger:read';
const today = new Date().toLocaleDateString('en-CA');
const PERIOD = today.slice(0, 7);
const YEAR = Number(today.slice(0, 4));
const sello = Date.now();

let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures += 1; console.log(`${ok ? 'OK   ' : 'FALLO'} ${name}${detail !== '' ? ' — ' + String(detail).slice(0, 300) : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (db, q) => execSync(`docker exec cmr-mysql mysql -uroot -proot123 -N -B ${db} -e "${q.replace(/"/g, '\\"')}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const num = (v) => Number(v === '' || v === 'NULL' ? 0 : v);
async function waitFor(fn, ms = 40000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = await fn(); if (v) return v; await sleep(400); }
  return null;
}

async function reporting(method, path, { body, org = ORG, perms = ALL, user = USER } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Organization-Id': org, 'X-User-Id': user };
  if (perms !== null) headers['X-Permissions'] = perms;
  const r = await fetch(REPORTING + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* no es JSON (CSV) */ }
  return { status: r.status, json, buf, headers: r.headers };
}
async function accounting(method, path, body) {
  const r = await fetch(ACCOUNTING + path, { method, headers: { 'Content-Type': 'application/json', 'X-Organization-Id': ORG, 'X-User-Id': USER, 'X-Permissions': ACC_PERMS }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  return { status: r.status, json: t ? JSON.parse(t) : null };
}

// ── organization-service de mentira: el informante del ATS ──
const orgStub = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url?.startsWith('/organizations/me')) res.end(JSON.stringify({ legalName: 'EMPRESA DE PRUEBA S.A.', tradeName: null, taxId: '1790016919001' }));
  else { res.statusCode = 404; res.end('{}'); }
});
await new Promise((ok) => orgStub.listen(3002, '127.0.0.1', ok));

const conn = await amqp.connect(AMQP);
const ch = await conn.createChannel();
await ch.assertExchange('crm.events', 'topic', { durable: true });
const publish = (type, payload, eventId = randomUUID()) => ch.publish('crm.events', type, Buffer.from(JSON.stringify(payload)), { persistent: true, headers: { eventId } });

// ── Eventos con TODO lo que necesitan contabilidad Y reporting ──
const CEDULA = '1710034065';
const RUC = '1790016919001';
let seq = 0;
const invoice = ({ id = randomUUID(), base, rate = 15, type = '01', day = today } = {}) => {
  const iva = Math.round((base * rate) / 100);
  seq += 1;
  return {
    organizationId: ORG, invoiceId: id, customerId: randomUUID(), number: `001-001-${String(sello % 1_000_000 * 10 + seq).padStart(9, '0')}`, sequentialNumber: String(seq).padStart(9, '0'),
    issueDate: `${day}T15:00:00.000Z`, documentTypeCode: type, relatedInvoiceId: null, posSaleId: null, paymentMethodCode: null, currencyCode: 'USD',
    establishmentId: randomUUID(), emissionPointId: randomUUID(),
    customerSnapshot: { id: randomUUID(), businessName: 'CLIENTE DE PRUEBA', identification: CEDULA, identificationTypeCode: '05' },
    issuerSnapshot: { legalName: 'EMPRESA DE PRUEBA S.A.', taxId: RUC, establishmentCode: '001', emissionPointCode: '001' },
    subtotalCents: base, taxTotalCents: iva, totalCents: base + iva,
    lines: [{ productId: null, description: 'Producto', quantity: 1, unitPriceCents: base, discountCents: 0, subtotalCents: base, taxes: [{ taxRateId: randomUUID(), kind: 'vat', rateSnapshot: `${rate}.00`, baseCents: base, amountCents: iva }] }],
  };
};
const billId = randomUUID();
const bill = () => ({
  organizationId: ORG, billId, internalNumber: `FC-${sello}`, supplierId: randomUUID(), supplier: { identification: RUC, legalName: 'DISTRIBUIDORA ANDINA', identificationType: 'RUC' },
  docType: '01', supplierDocument: '002-003-000004567', issueDate: today, dueDate: today, currencyCode: 'USD', subtotalCents: 20000, taxCents: 3000, totalCents: 23000,
  authorizationNumber: '1209202601179001691900120020030000045671234567815', paymentMethodCode: null, supportCode: null,
  taxBreakdown: [{ taxCode: '2', ratePercent: 15, baseCents: 20000, amountCents: 3000 }], matchStatus: 'not_applicable',
  lines: [{ kind: 'expense', subtotalCents: 20000, vatCents: 3000, iceCents: 0, irbpnrCents: 0, priceVarianceCents: 0 }],
});
const withholdingId = randomUUID();
const withholding = () => ({
  organizationId: ORG, withholdingId, fiscalInvoiceId: randomUUID(), number: '001-001-000000007', issueDate: `${today}T16:00:00.000Z`, establishmentId: randomUUID(), currencyCode: 'USD',
  authorizationNumber: '1509202607179001691900110010010000000071234567818', fiscalPeriod: `${PERIOD.slice(5)}/${PERIOD.slice(0, 4)}`,
  supplier: { identificationType: 'RUC', identification: RUC, businessName: 'DISTRIBUIDORA ANDINA' },
  support: { documentCode: '01', number: '002-003-000004567', issueDate: today, supportCode: '01', authorizationNumber: '1209202601179001691900120020030000045671234567815' },
  lines: [{ tax: 'income', retentionCode: '312', baseCents: 20000, ratePercent: 1.75, amountCents: 350 }, { tax: 'vat', retentionCode: '1', baseCents: 3000, ratePercent: 30, amountCents: 900 }],
  incomeTaxWithheldCents: 350, vatWithheldCents: 900, isdWithheldCents: 0, totalWithheldCents: 1250,
});

// ── Contabilidad de la organización nueva ──
console.log(`Organización de prueba: ${ORG} · periodo ${PERIOD}`);
const setup = await accounting('POST', '/accounting/setup', { chartTemplate: 'ec-supercias', fiscalYear: YEAR });
check('contabilidad: alta de la organización', setup.status === 201, setup.status);
const health = await fetch(`${REPORTING}/health`).then((r) => r.status).catch(() => 0);
check('reporting-service responde', health === 200, health);

// ── 1. Ventas, nota de crédito, una venta anulada, una compra y su retención ──
const A = invoice({ base: 10000 });
const B = invoice({ base: 5000 });
const C = invoice({ base: 2000, rate: 0 });
const NC = invoice({ base: 1000, type: '04' });
const D = invoice({ base: 9900 });
for (const e of [A, B, C, NC, D]) publish('billing.invoice.issued', e);
publish('billing.invoice.voided', { organizationId: ORG, invoiceId: D.invoiceId, number: D.number, issueDate: D.issueDate, reason: 'prueba', voidedAt: new Date().toISOString() });
// La RETENCIÓN llega ANTES que la compra que cita (el caso difícil), y la compra llega después.
publish('fiscal.ec.withholding.issued', withholding());
await sleep(2500);
publish('purchasing.bill.posted', bill());

const documentsReady = await waitFor(async () => {
  const total = num(sql('reporting_db', `select count(*) from report_documents where organization_id='${ORG}'`));
  const voided = num(sql('reporting_db', `select count(*) from report_documents where organization_id='${ORG}' and status='voided'`));
  return total === 7 && voided === 1 ? total : null;
});
check('reporting recibió los 7 comprobantes (5 ventas, 1 compra, 1 retención) y marcó 1 anulado', !!documentsReady, sql('reporting_db', `select direction, status, count(*) from report_documents where organization_id='${ORG}' group by 1,2`).replace(/\n/g, ' | '));

// El desglose y las líneas se GUARDAN (lo que el código anterior construía y nunca escribía).
// La venta anulada puede llegar a reporting antes que su emisión: queda un comprobante «anulado» y su desglose se completa al llegar la emisión.
const taxRows = () => num(sql('reporting_db', `select count(*) from report_document_taxes t join report_documents d on d.id=t.document_id where d.organization_id='${ORG}'`));
const taxesReady = await waitFor(async () => (taxRows() === 6 ? true : null), 15000);
check('el desglose de impuestos está en la base (4 ventas + 1 anulada + 1 compra)', !!taxesReady, taxRows());
check('las líneas de retención están en la base', num(sql('reporting_db', `select count(*) from report_withholding_lines l join report_documents d on d.id=l.document_id where d.organization_id='${ORG}'`)) === 2);
check('la retención que llegó ANTES quedó enlazada a la compra cuando ésta llegó', sql('reporting_db', `select count(*) from report_withholding_lines l join report_documents d on d.id=l.document_id where d.organization_id='${ORG}' and l.supports_source_id='${billId}'`) === '2' && sql('reporting_db', `select related_source_id from report_documents where organization_id='${ORG}' and direction='withholding_issued'`) === billId);
check('la fecha de la compra no se corrió un día (se guardó tal cual)', sql('reporting_db', `select issue_date from report_documents where organization_id='${ORG}' and direction='purchase'`) === today, sql('reporting_db', `select issue_date from report_documents where organization_id='${ORG}' and direction='purchase'`));

// ── 2. Duplicados y fuera de orden ──
const eid = randomUUID();
publish('billing.invoice.issued', A, eid); publish('billing.invoice.issued', A, eid); publish('billing.invoice.issued', A, randomUUID());
const late = invoice({ base: 3000 });
publish('billing.invoice.voided', { organizationId: ORG, invoiceId: late.invoiceId, number: late.number, issueDate: late.issueDate, reason: 'antes', voidedAt: new Date().toISOString() });
await sleep(2500);
publish('billing.invoice.issued', late);
await sleep(3500);
check('el mismo comprobante en 3 mensajes sigue siendo UNO', num(sql('reporting_db', `select count(*) from report_documents where organization_id='${ORG}' and source_id='${A.invoiceId}'`)) === 1);
check('la anulación que llegó ANTES deja el comprobante completo y anulado (una sola fila)',
  sql('reporting_db', `select concat(status,'/',document_type_code,'/',total_cents) from report_documents where organization_id='${ORG}' and source_id='${late.invoiceId}'`) === 'voided/01/3450'
  && num(sql('reporting_db', `select count(*) from report_documents where organization_id='${ORG}' and source_id='${late.invoiceId}'`)) === 1,
  sql('reporting_db', `select concat(status,'/',document_type_code,'/',total_cents) from report_documents where organization_id='${ORG}' and source_id='${late.invoiceId}'`));
check('ese comprobante tardío SÍ guardó su desglose', num(sql('reporting_db', `select count(*) from report_document_taxes t join report_documents d on d.id=t.document_id where d.source_id='${late.invoiceId}'`)) === 1);

// ── 3. Contabilidad asienta lo mismo ──
const ledger = (role, side) => {
  const sign = side === 'credit' ? 'credit_cents - debit_cents' : 'debit_cents - credit_cents';
  return num(sql('accounting_db', `select coalesce(sum(${sign}),0) from journal_lines jl join accounts a on a.id=jl.account_id where jl.organization_id='${ORG}' and a.system_role='${role}' and jl.is_posted=1`));
};
const ledgerReady = await waitFor(async () => (ledger('vat_payable', 'credit') !== 0 && ledger('vat_credit', 'debit') !== 0 && ledger('vat_withholding_payable', 'credit') !== 0 ? true : null), 45000);
check('contabilidad asentó las ventas, la compra y la retención', !!ledgerReady, `vat_payable=${ledger('vat_payable', 'credit')} vat_credit=${ledger('vat_credit', 'debit')} ret_iva=${ledger('vat_withholding_payable', 'credit')}`);

// ── 4. Generar y comparar con cifras hechas a mano Y con el mayor ──
const f104 = await reporting('POST', `/reporting/annexes/f104/${PERIOD}/generate`);
const f103 = await reporting('POST', `/reporting/annexes/f103/${PERIOD}/generate`);
const ats = await reporting('POST', `/reporting/annexes/ats/${PERIOD}/generate`);
check('se generan los tres anexos (201)', f104.status === 201 && f103.status === 201 && ats.status === 201, `${f104.status}/${f103.status}/${ats.status}`);
const s104 = f104.json?.run?.summary ?? {};
// IVA de ventas: 15,00 + 7,50 - 1,50 (nota de crédito) = 21,00. Las dos anuladas no cuentan. Compras 30,00. IVA retenido 9,00.
check('104 a mano: IVA generado 21,00, IVA de compras 30,00, IVA retenido practicado 9,00', s104.ivaGeneradoCents === 2100 && s104.ivaComprasCents === 3000 && s104.ivaRetenidoPracticadoCents === 900, JSON.stringify(s104));
check('103 a mano: renta retenida 3,50 sobre base 200,00 (solo el concepto 312; el IVA no entra)', f103.json?.run?.summary?.totalRetenidoCents === 350 && f103.json?.run?.summary?.totalBaseCents === 20000, JSON.stringify(f103.json?.run?.summary));
check('ATS: la compra trae su retención enlazada y hay 2 anulados', ats.json?.run?.content?.compras?.[0]?.retenciones?.length === 1 && ats.json?.run?.content?.anulados?.length === 2, `${ats.json?.run?.content?.compras?.[0]?.retenciones?.length} / ${ats.json?.run?.content?.anulados?.length}`);
check('el informante del ATS viene de organization-service', ats.json?.run?.content?.informante?.ruc === '1790016919001');

check('LA PRUEBA DE ORO — IVA de ventas del 104 = «IVA por pagar» del libro mayor', s104.ivaGeneradoCents === ledger('vat_payable', 'credit'), `${s104.ivaGeneradoCents} vs ${ledger('vat_payable', 'credit')}`);
check('LA PRUEBA DE ORO — IVA de compras del 104 = «IVA crédito» del libro mayor', s104.ivaComprasCents === ledger('vat_credit', 'debit'), `${s104.ivaComprasCents} vs ${ledger('vat_credit', 'debit')}`);
check('LA PRUEBA DE ORO — IVA retenido del 104 = «Retenciones de IVA por pagar»', s104.ivaRetenidoPracticadoCents === ledger('vat_withholding_payable', 'credit'), `${s104.ivaRetenidoPracticadoCents} vs ${ledger('vat_withholding_payable', 'credit')}`);
check('LA PRUEBA DE ORO — renta retenida del 103 = «Retenciones en la fuente por pagar»', f103.json?.run?.summary?.totalRetenidoCents === ledger('income_tax_withholding_payable', 'credit'), `${f103.json?.run?.summary?.totalRetenidoCents} vs ${ledger('income_tax_withholding_payable', 'credit')}`);

const rec104 = await reporting('GET', `/reporting/annexes/f104/${PERIOD}/reconciliation`);
check('la conciliación del servicio (que consulta a contabilidad por HTTP) da OK y diferencia 0 en todo', rec104.status === 200 && rec104.json?.status === 'ok' && rec104.json.items.every((i) => i.differenceCents === 0), JSON.stringify(rec104.json?.items?.map((i) => [i.code, i.annexCents, i.accountingCents])));
const rec103 = await reporting('GET', `/reporting/annexes/f103/${PERIOD}/reconciliation`);
check('la conciliación del 103 también', rec103.json?.status === 'ok', JSON.stringify(rec103.json?.items));

// ── 5. Versiones y concurrencia ──
const again = await reporting('POST', `/reporting/annexes/f104/${PERIOD}/generate`);
check('regenerar sin cambios es 200 y devuelve la MISMA versión', again.status === 200 && again.json.run.id === f104.json.run.id && again.json.created === false);
const burst = await Promise.all(Array.from({ length: 10 }, () => reporting('POST', `/reporting/annexes/f103/${PERIOD}/generate`)));
check('10 generaciones simultáneas del 103: ninguna falla', burst.every((r) => [200, 201].includes(r.status)), burst.map((r) => r.status).join(','));
check('…y siguen siendo UNA sola versión en la base', num(sql('reporting_db', `select count(*) from tax_annex_runs where organization_id='${ORG}' and annex='f103'`)) === 1, sql('reporting_db', `select count(*) from tax_annex_runs where organization_id='${ORG}' and annex='f103'`));
const fresh = Array.from({ length: 10 }, () => reporting('POST', `/reporting/annexes/ats/${PERIOD}/generate`));
await Promise.all(fresh);
check('10 generaciones simultáneas del ATS (sin cambios): sigue la versión 1', num(sql('reporting_db', `select count(*) from tax_annex_runs where organization_id='${ORG}' and annex='ats'`)) === 1);

// Un comprobante nuevo + 10 generaciones a la vez: nace la versión 2 UNA sola vez.
publish('billing.invoice.issued', invoice({ base: 4000 }));
await sleep(3000);
const race = await Promise.all(Array.from({ length: 10 }, () => reporting('POST', `/reporting/annexes/f104/${PERIOD}/generate`)));
const versions = sql('reporting_db', `select group_concat(version order by version) from tax_annex_runs where organization_id='${ORG}' and annex='f104'`);
check('con un cambio real y 10 generaciones a la vez nace UNA versión nueva (la 2), sin errores', versions === '1,2' && race.every((r) => [200, 201].includes(r.status)) && race.filter((r) => r.status === 201).length === 1, `${versions} · ${race.map((r) => r.status).join(',')}`);

// ── 6. Casilleros manuales ──
const before = (await reporting('GET', `/reporting/annexes/f104/${PERIOD}/manual-inputs`)).json;
const put1 = await reporting('PUT', `/reporting/annexes/f104/${PERIOD}/manual-inputs/credito_anterior`, { body: { amountCents: 500 } });
const put2 = await reporting('PUT', `/reporting/annexes/f104/${PERIOD}/manual-inputs/credito_anterior`, { body: { amountCents: 800 } });
check('un casillero manual se guarda y se REEMPLAZA sin chocar con el UNIQUE', put1.status === 200 && put2.status === 200 && num(sql('reporting_db', `select count(*) from tax_annex_manual_inputs where organization_id='${ORG}'`)) === 1 && num(sql('reporting_db', `select amount_cents from tax_annex_manual_inputs where organization_id='${ORG}'`)) === 800, `${put1.status}/${put2.status}`);
check('un casillero que no existe es 422', (await reporting('PUT', `/reporting/annexes/f104/${PERIOD}/manual-inputs/inventado`, { body: { amountCents: 1 } })).status === 422);
const v3 = await reporting('POST', `/reporting/annexes/f104/${PERIOD}/generate`);
check('regenerar con el casillero crea la versión 3 y baja el saldo en 8,00', v3.status === 201 && v3.json.run.version === 3 && v3.json.run.summary.saldoCents === (race.find((r) => r.status === 201)?.json?.run?.summary?.saldoCents ?? NaN) - 800, `${v3.json?.run?.summary?.saldoCents}`);
const detail = await reporting('GET', `/reporting/annexes/runs/${v3.json.run.id}`);
check('el detalle de la versión trae hallazgos GUARDADOS y los cambios contra la anterior', detail.status === 200 && detail.json.findings.length > 0 && detail.json.previous?.version === 2 && Array.isArray(detail.json.changes), `findings=${detail.json?.findings?.length} previous=${detail.json?.previous?.version}`);
check('los hallazgos están en la base', num(sql('reporting_db', `select count(*) from tax_annex_findings f join tax_annex_runs r on r.id=f.run_id where r.organization_id='${ORG}'`)) > 0);

// ── 7. Descargas, permisos y aislamiento ──
const csv = await reporting('GET', `/reporting/annexes/runs/${f104.json.run.id}/export?format=csv`);
check('el CSV se descarga con BOM (EF BB BF) y los importes con 2 decimales', csv.status === 200 && csv.buf[0] === 0xef && csv.buf[1] === 0xbb && csv.buf[2] === 0xbf && csv.buf.toString('utf8').includes('IVA generado en ventas,21.00'), csv.buf.toString('utf8').slice(0, 120));
const xml = await reporting('GET', `/reporting/annexes/runs/${ats.json.run.id}/export?format=xml`);
check('el XML del ATS responde 501 ATS_SCHEMA_PENDING (no se inventa)', xml.status === 501 && xml.json?.code === 'ATS_SCHEMA_PENDING');
check('sin permiso es 403; sin organización es 401', (await reporting('GET', '/reporting/annexes/runs', { perms: 'tax_annex:generate' })).status === 403 && (await fetch(`${REPORTING}/reporting/annexes/runs`)).status === 401);
check('otra organización no ve las versiones, ni los comprobantes, ni puede exportar', (await reporting('GET', '/reporting/annexes/runs', { org: OTHER_ORG })).json.total === 0
  && (await reporting('GET', '/reporting/documents', { org: OTHER_ORG })).json.total === 0
  && (await reporting('GET', `/reporting/annexes/runs/${f104.json.run.id}/export?format=csv`, { org: OTHER_ORG })).status === 404);
const docs = await reporting('GET', '/reporting/documents?direction=sale&pageSize=50');
check('el listado de comprobantes filtra por tipo', docs.status === 200 && docs.json.items.every((d) => d.direction === 'sale') && docs.json.total === 7, docs.json?.total);
check('las acciones quedaron en la bitácora (outbox): generaciones, descargas y casilleros', num(sql('reporting_db', `select count(*) from outbox_messages where type='reporting.tax_annex.generated'`)) >= 5
  && num(sql('reporting_db', `select count(*) from outbox_messages where type='reporting.tax_annex.exported'`)) >= 1
  && num(sql('reporting_db', `select count(*) from outbox_messages where type='reporting.tax_annex.manual_input_set'`)) >= 2);

await ch.close(); await conn.close(); orgStub.close();
console.log(failures === 0 ? '\nTODO OK' : `\n${failures} comprobación(es) FALLARON`);
process.exit(failures === 0 ? 0 : 1);
