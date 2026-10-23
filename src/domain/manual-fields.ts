import { ValidationError } from './errors.js';
import type { AnnexType } from './reporting.js';

/**
 * Casilleros que el contador completa a mano porque el sistema NO puede (ni debe) deducirlos: dependen de su criterio o de datos que
 * el ERP no tiene. Sin esta lista cualquier texto sería un casillero válido y un error de tipeo pasaría por dato.
 */
export interface ManualField {
  label: string;
  min?: number;
  max?: number;
  /** Lo que se usa si el contador no lo completó. */
  defaultCents: number;
}

export const MANUAL_FIELDS: Record<AnnexType, Record<string, ManualField>> = {
  ats: {},
  f103: {},
  f104: {
    // En puntos básicos: 10000 = 100 %. Solo es menor si parte de las ventas no da derecho a crédito tributario.
    factor_proporcionalidad_bps: { label: 'Factor de proporcionalidad del crédito tributario (puntos básicos, 10000 = 100 %)', min: 0, max: 10_000, defaultCents: 10_000 },
    credito_anterior: { label: 'Crédito tributario del mes anterior (centavos)', min: 0, defaultCents: 0 },
    iva_retenido_sufrido: { label: 'IVA que nos retuvieron los clientes (centavos)', min: 0, defaultCents: 0 },
    ajustes: { label: 'Ajustes al impuesto a pagar (centavos; positivo aumenta lo que se paga)', defaultCents: 0 },
  },
};

export function manualFieldCodes(annex: AnnexType): string[] {
  return Object.keys(MANUAL_FIELDS[annex]);
}

/** Valida el casillero y su importe; lanza `ValidationError` (422) si no existe o está fuera de rango. */
export function validateManualField(annex: AnnexType, fieldCode: string, amountCents: number): void {
  const field = MANUAL_FIELDS[annex][fieldCode];
  if (!field) {
    const allowed = manualFieldCodes(annex);
    throw new ValidationError([
      { field: 'fieldCode', message: allowed.length ? `Casillero desconocido. Los de este anexo son: ${allowed.join(', ')}.` : 'Este anexo no tiene casilleros manuales.' },
    ]);
  }
  if (!Number.isSafeInteger(amountCents)) throw new ValidationError([{ field: 'amountCents', message: 'El importe debe ser un entero.' }]);
  if (field.min !== undefined && amountCents < field.min) throw new ValidationError([{ field: 'amountCents', message: `El mínimo es ${field.min}.` }]);
  if (field.max !== undefined && amountCents > field.max) throw new ValidationError([{ field: 'amountCents', message: `El máximo es ${field.max}.` }]);
}

/** Valor del casillero: el que puso el contador o, si no puso ninguno, el predeterminado. */
export function manualValue(annex: AnnexType, fieldCode: string, manual: ReadonlyMap<string, number>): number {
  return manual.get(fieldCode) ?? MANUAL_FIELDS[annex][fieldCode]?.defaultCents ?? 0;
}
