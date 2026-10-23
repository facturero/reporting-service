import { periodLastDay, periodStart } from '../../domain/dates.js';
import { AnnexNotGeneratedError } from '../../domain/errors.js';
import type { AnnexType, ReadRepositories } from '../../domain/reporting.js';
import type { AccountingCatalogPort, RoleMovement } from '../ports.js';

export interface ReconciliationItem {
  code: string;
  label: string;
  /** Rol contable con el que se compara. */
  role: string;
  annexCents: number;
  accountingCents: number;
  differenceCents: number;
}

export interface Reconciliation {
  annex: AnnexType;
  period: string;
  runId: string;
  version: number;
  /** `false` si la organización no tiene contabilidad configurada: no hay con qué comparar. */
  available: boolean;
  status: 'ok' | 'mismatch' | 'unavailable';
  items: ReconciliationItem[];
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' ? (v as Rec) : {});
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

/** Qué cifra del anexo se compara con qué rol contable, y en qué sentido se lee el saldo del rol (crédito − débito o al revés). */
interface Rule {
  code: string;
  label: string;
  role: string;
  side: 'credit' | 'debit';
  annexCents: (summary: Rec, content: Rec) => number;
}

const RULES: Record<AnnexType, Rule[]> = {
  f104: [
    { code: 'vat_generated', label: 'IVA generado en ventas (neto de notas de crédito)', role: 'vat_payable', side: 'credit', annexCents: (_s, c) => num(rec(c.ventas).ivaGeneradoNetoCents) },
    { code: 'vat_purchases', label: 'IVA de compras (crédito tributario)', role: 'vat_credit', side: 'debit', annexCents: (_s, c) => num(rec(c.compras).ivaCents) },
    { code: 'vat_withheld', label: 'IVA retenido a proveedores', role: 'vat_withholding_payable', side: 'credit', annexCents: (_s, c) => num(c.ivaRetenidoPracticadoCents) },
  ],
  f103: [{ code: 'income_withheld', label: 'Retenciones de renta practicadas', role: 'income_tax_withholding_payable', side: 'credit', annexCents: (s) => num(s.totalRetenidoCents) }],
  ats: [
    { code: 'vat_sales', label: 'IVA de ventas', role: 'vat_payable', side: 'credit', annexCents: (s) => num(s.ventasIvaCents) },
    { code: 'vat_purchases', label: 'IVA de compras', role: 'vat_credit', side: 'debit', annexCents: (s) => num(s.comprasIvaCents) },
  ],
};

const balanceOf = (m: RoleMovement | undefined, side: 'credit' | 'debit'): number => (m ? (side === 'credit' ? m.creditCents - m.debitCents : m.debitCents - m.creditCents) : 0);

/**
 * Compara lo que dice la ÚLTIMA versión del anexo con lo que dice el libro mayor para el mismo periodo. Una diferencia no se oculta ni
 * se «ajusta»: se muestra para que el contador la explique (un documento sin asiento, un asiento manual, un comprobante anulado después…).
 */
export class GetReconciliationUseCase {
  constructor(
    private readonly repos: ReadRepositories,
    private readonly accounting: AccountingCatalogPort,
  ) {}

  async execute(organizationId: string, annex: AnnexType, period: string): Promise<Reconciliation> {
    const run = await this.repos.taxAnnexRuns.findLatestByPeriod(organizationId, annex, period);
    if (!run) throw new AnnexNotGeneratedError();

    const base = { annex, period, runId: run.id, version: run.version };
    const movements = await this.accounting.getRoleMovements(organizationId, periodStart(period), periodLastDay(period));
    if (movements === null) return { ...base, available: false, status: 'unavailable', items: [] };

    const summary = rec(run.summaryJson);
    const content = rec(run.contentJson);
    const items = RULES[annex].map((rule): ReconciliationItem => {
      const annexCents = rule.annexCents(summary, content);
      const accountingCents = balanceOf(movements[rule.role], rule.side);
      return { code: rule.code, label: rule.label, role: rule.role, annexCents, accountingCents, differenceCents: annexCents - accountingCents };
    });
    return { ...base, available: true, status: items.every((i) => i.differenceCents === 0) ? 'ok' : 'mismatch', items };
  }
}
