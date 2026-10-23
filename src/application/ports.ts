import type { Informant } from '../domain/ats.js';

export interface RoleMovement {
  debitCents: number;
  creditCents: number;
}

/**
 * Contabilidad (accounting-service), solo lectura. Devuelve el movimiento (débitos y créditos) de las cuentas de cada ROL DEL SISTEMA
 * (`vat_payable`, `vat_credit`, `income_tax_withholding_payable`, `vat_withholding_payable`…) dentro de [from, to].
 *
 * `null` = la organización no tiene contabilidad configurada. Si contabilidad no responde se LANZA `CatalogUnavailableError`: darlo por
 * cero haría pasar por cuadrado un anexo que no se pudo comprobar.
 */
export interface AccountingCatalogPort {
  getRoleMovements(organizationId: string, from: string, to: string): Promise<Record<string, RoleMovement> | null>;
}

/** Organización (organization-service): el informante del ATS. `null` si no hay datos; lanza `CatalogUnavailableError` si no responde. */
export interface OrganizationCatalogPort {
  getTaxpayer(organizationId: string): Promise<Informant | null>;
}

export type Clock = () => Date;
