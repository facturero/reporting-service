import type { Informant } from '../../domain/ats.js';
import { CatalogUnavailableError } from '../../domain/errors.js';
import type { AccountingCatalogPort, OrganizationCatalogPort, RoleMovement } from '../../application/ports.js';

const TIMEOUT_MS = 8_000;

/** Server-to-server: este servicio pone él mismo las cabeceras que los demás esperan del gateway. */
const headers = (organizationId: string, permissions: string) => ({
  'X-Organization-Id': organizationId,
  'X-User-Id': 'reporting-service',
  'X-Permissions': permissions,
});

async function getJson<T>(url: string, organizationId: string, permissions: string, service: string): Promise<{ status: number; body: T | null }> {
  let response: Response;
  try {
    response = await fetch(url, { headers: headers(organizationId, permissions), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    console.warn(`[reporting-service] no se pudo consultar ${service}: ${(err as Error).message}`);
    throw new CatalogUnavailableError(`No se pudo consultar ${service}. Reintenta en un momento.`);
  }
  if (response.status === 404) return { status: 404, body: null };
  if (!response.ok) {
    console.warn(`[reporting-service] ${service} respondió ${response.status}`);
    throw new CatalogUnavailableError(`No se pudo consultar ${service}. Reintenta en un momento.`);
  }
  return { status: response.status, body: (await response.json()) as T };
}

interface AccountDto {
  id: string;
  systemRole: string | null;
}

interface TrialBalanceDto {
  rows: { accountId: string | null; isPostable: boolean; synthetic: boolean; debitCents: number; creditCents: number }[];
}

/**
 * Contabilidad por HTTP. No existe un endpoint «saldo por rol»: se arma con el plan de cuentas (que dice qué rol lleva cada cuenta) y el
 * balance de comprobación del rango (que dice cuánto se movió en cada cuenta). Solo cuentan las de detalle: las de agrupación ya suman a
 * sus hijas y contarlas dos veces duplicaría el importe.
 */
export class HttpAccountingCatalog implements AccountingCatalogPort {
  constructor(private readonly baseUrl: string) {}

  async getRoleMovements(organizationId: string, from: string, to: string): Promise<Record<string, RoleMovement> | null> {
    const accounts = await getJson<AccountDto[]>(`${this.baseUrl}/accounting/accounts`, organizationId, 'account:read', 'la contabilidad');
    if (!accounts.body || accounts.body.length === 0) return null; // sin plan de cuentas no hay contabilidad con qué comparar

    const roleOf = new Map<string, string>();
    for (const a of accounts.body) if (a.systemRole) roleOf.set(a.id, a.systemRole);

    const query = new URLSearchParams({ from, to, includeZero: 'false' });
    const trial = await getJson<TrialBalanceDto>(`${this.baseUrl}/accounting/reports/trial-balance?${query}`, organizationId, 'ledger:read', 'la contabilidad');
    if (!trial.body) return null;

    const out: Record<string, RoleMovement> = {};
    for (const row of trial.body.rows) {
      if (!row.accountId || !row.isPostable || row.synthetic) continue;
      const role = roleOf.get(row.accountId);
      if (!role) continue;
      const m = (out[role] ??= { debitCents: 0, creditCents: 0 });
      m.debitCents += Number(row.debitCents);
      m.creditCents += Number(row.creditCents);
    }
    return out;
  }
}

/** Organización: razón social y RUC del informante. */
export class HttpOrganizationCatalog implements OrganizationCatalogPort {
  constructor(private readonly baseUrl: string) {}

  async getTaxpayer(organizationId: string): Promise<Informant | null> {
    const res = await getJson<{ legalName?: string | null; taxId?: string | null }>(`${this.baseUrl}/organizations/me`, organizationId, 'organization:read', 'los datos de la organización');
    const legalName = res.body?.legalName?.trim();
    const taxId = res.body?.taxId?.trim();
    return legalName && taxId ? { ruc: taxId, legalName } : null;
  }
}
