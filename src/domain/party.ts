import { validateRucOrCedula } from './ruc.js';

/** Identificación de «consumidor final» en una factura electrónica del SRI. */
export const CONSUMIDOR_FINAL_ID = '9999999999999';

/**
 * Tipo de identificación en códigos del SRI (los mismos que usa fiscal-ecuador al armar la factura): 04 RUC, 05 cédula, 06 pasaporte,
 * 07 consumidor final, 08 identificación del exterior.
 *
 * Cada servicio lo manda a su manera (billing ya en código; compras y fiscal como RUC/CEDULA/PASAPORTE/EXTERIOR). Lo que no se reconoce
 * queda en `null`: NO se inventa un tipo.
 */
const BY_NAME: Record<string, string> = { RUC: '04', CEDULA: '05', PASAPORTE: '06', CONSUMIDOR_FINAL: '07', EXTERIOR: '08' };

export function normalizeIdentificationType(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (/^\d{2}$/.test(value)) return value;
  return BY_NAME[value.toUpperCase()] ?? null;
}

export function isConsumidorFinal(type: string | null, identification: string | null): boolean {
  return type === '07' || identification === CONSUMIDOR_FINAL_ID;
}

export type PartyProblem = 'MISSING_PARTY_ID' | 'MISSING_PARTY_ID_TYPE' | 'INVALID_PARTY_ID' | 'MISSING_PARTY_NAME';

/**
 * Qué falta o está mal en un tercero (cliente, proveedor o sujeto retenido). El dígito verificador solo se comprueba para cédula y RUC:
 * el pasaporte y la identificación del exterior no tienen uno, y el consumidor final es válido tal cual.
 */
export interface PartyIssue {
  problem: PartyProblem;
  message: string;
  certainty?: 'high' | 'low';
}

export function checkParty(party: { type: string | null; identification: string | null; name: string | null }): PartyIssue[] {
  const out: PartyIssue[] = [];
  if (isConsumidorFinal(party.type, party.identification)) return out;
  if (!party.identification) {
    out.push({ problem: 'MISSING_PARTY_ID', message: 'Falta la identificación.' });
  } else if (party.type === null) {
    out.push({ problem: 'MISSING_PARTY_ID_TYPE', message: 'Falta el tipo de identificación (RUC, cédula, pasaporte…).' });
  } else if (party.type === '04' || party.type === '05') {
    const result = validateRucOrCedula(party.identification);
    if (!result.valid) {
      // Un rechazo de certeza baja (dígito verificador de un RUC de sociedad o entidad pública) es solo una advertencia: hay RUC antiguos válidos que no lo pasan.
      out.push({ problem: 'INVALID_PARTY_ID', certainty: result.certainty ?? 'high', message: `Identificación inválida: ${result.message ?? 'no pasa el dígito verificador'}` });
    }
  }
  if (!party.name) out.push({ problem: 'MISSING_PARTY_NAME', message: 'Falta el nombre o la razón social.' });
  return out;
}
