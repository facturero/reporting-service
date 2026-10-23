/**
 * Validación de cédula y RUC ecuatorianos (algoritmos de verificación publicados; módulo 10 para personas naturales y módulo 11 para
 * sociedades y entidades públicas).
 *
 *  - Cédula (10 dígitos) y RUC de persona natural (cédula + establecimiento `001`…): tercer dígito 0-5, módulo 10.
 *  - RUC de sociedad privada (13 dígitos): tercer dígito 9, módulo 11 sobre los 9 primeros, verificador en la posición 10.
 *  - RUC de entidad pública (13 dígitos): tercer dígito 6, módulo 11 sobre los 8 primeros, verificador en la posición 9.
 *
 * `certainty` dice cuánto se puede confiar en un rechazo: el módulo 10 de las cédulas es exacto, pero hay RUC de sociedades y de entidades
 * públicas antiguos que el SRI aceptó y que no pasan el módulo 11. Por eso un rechazo de esos tipos es solo una advertencia.
 */
export type RucKind = 'cedula' | 'ruc_natural' | 'ruc_juridico' | 'ruc_publico' | 'invalid';

export interface RucValidationResult {
  valid: boolean;
  type: RucKind;
  message?: string;
  certainty?: 'high' | 'low';
}

const ok = (type: RucKind): RucValidationResult => ({ valid: true, type });
const bad = (message: string, certainty: 'high' | 'low' = 'high'): RucValidationResult => ({ valid: false, type: 'invalid', message, certainty });

const provinceOk = (id: string): boolean => {
  const p = Number(id.slice(0, 2));
  return (p >= 1 && p <= 24) || p === 30; // 30 = ecuatorianos registrados en el exterior
};

function weighted(digits: string, coefficients: number[], reduce = false): number {
  let sum = 0;
  for (let i = 0; i < coefficients.length; i += 1) {
    let v = Number(digits[i]) * coefficients[i]!;
    if (reduce && v > 9) v -= 9;
    sum += v;
  }
  return sum;
}

function mod10Ok(id10: string): boolean {
  const check = (10 - (weighted(id10, [2, 1, 2, 1, 2, 1, 2, 1, 2], true) % 10)) % 10;
  return check === Number(id10[9]);
}

/** Verificador de módulo 11: 11 - (suma mod 11), y 11 se toma como 0. Un resultado de 10 no existe como dígito. */
function mod11Check(digits: string, coefficients: number[]): number | null {
  const r = 11 - (weighted(digits, coefficients) % 11);
  if (r === 11) return 0;
  if (r === 10) return null;
  return r;
}

export function validateRucOrCedula(value: string): RucValidationResult {
  const id = value.trim().replace(/[-\s]/g, '');
  if (!/^\d+$/.test(id)) return bad('Solo debe tener dígitos.');
  if (id.length !== 10 && id.length !== 13) return bad('Debe tener 10 dígitos (cédula) o 13 (RUC).');
  if (!provinceOk(id)) return bad('Los dos primeros dígitos no corresponden a una provincia.');

  const third = Number(id[2]);
  if (third <= 5) {
    if (!mod10Ok(id.slice(0, 10))) return bad('No pasa el dígito verificador de la cédula.');
    if (id.length === 13) return id.slice(10) === '000' ? bad('El establecimiento del RUC no puede ser 000.') : ok('ruc_natural');
    return ok('cedula');
  }

  if (id.length !== 13) return bad('Una cédula no puede tener el tercer dígito mayor que 5.');

  if (third === 9) {
    if (id.slice(10) === '000') return bad('El establecimiento del RUC no puede ser 000.');
    return mod11Check(id, [4, 3, 2, 7, 6, 5, 4, 3, 2]) === Number(id[9]) ? ok('ruc_juridico') : bad('No pasa el dígito verificador del RUC de la sociedad.', 'low');
  }

  if (third === 6) {
    if (id.slice(9) === '0000') return bad('El establecimiento del RUC no puede ser 0000.');
    return mod11Check(id, [3, 2, 7, 6, 5, 4, 3, 2]) === Number(id[8]) ? ok('ruc_publico') : bad('No pasa el dígito verificador del RUC de la entidad pública.', 'low');
  }

  return bad('El tercer dígito del RUC debe ser 0-5 (persona natural), 6 (entidad pública) o 9 (sociedad).');
}

/** Solo valida formato y dígito verificador; no distingue tipo. */
export function isValidEcuadorId(value: string): boolean {
  return validateRucOrCedula(value).valid;
}
