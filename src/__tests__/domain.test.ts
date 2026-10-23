import { describe, expect, it } from 'vitest';
import { canonicalJson, contentHash } from '../domain/canonical.js';
import { calendarDay, dayInPeriod, localDateOf, periodEnd, periodLastDay, periodStart } from '../domain/dates.js';
import { ValidationError } from '../domain/errors.js';
import { manualValue, validateManualField } from '../domain/manual-fields.js';
import { checkParty, normalizeIdentificationType } from '../domain/party.js';
import { buildF103Csv, csvCell, toCsv } from '../domain/report-csv.js';
import { validateRucOrCedula } from '../domain/ruc.js';
import { CEDULA, RUC_PUBLICO, RUC_SOCIEDAD } from './fixtures.js';

describe('RUC y cédula', () => {
  it('acepta una cédula, un RUC de persona natural, de sociedad y de entidad pública válidos', () => {
    expect(validateRucOrCedula(CEDULA)).toMatchObject({ valid: true, type: 'cedula' });
    expect(validateRucOrCedula(`${CEDULA}001`)).toMatchObject({ valid: true, type: 'ruc_natural' }); // cédula + establecimiento: el caso más común de proveedor persona natural
    expect(validateRucOrCedula(RUC_SOCIEDAD)).toMatchObject({ valid: true, type: 'ruc_juridico' });
    expect(validateRucOrCedula(RUC_PUBLICO)).toMatchObject({ valid: true, type: 'ruc_publico' });
  });

  it('rechaza con certeza ALTA una cédula con el verificador mal; con certeza BAJA un RUC de sociedad (hay RUC antiguos válidos que no pasan el módulo 11)', () => {
    expect(validateRucOrCedula('1710034066')).toMatchObject({ valid: false, certainty: 'high' });
    expect(validateRucOrCedula('1790016918001')).toMatchObject({ valid: false, certainty: 'low' });
  });

  it('rechaza lo que no puede ser un RUC: letras, longitud, provincia inexistente, establecimiento 000', () => {
    expect(validateRucOrCedula('17100340AB').valid).toBe(false);
    expect(validateRucOrCedula('171003406').valid).toBe(false);
    expect(validateRucOrCedula('9910034065').valid).toBe(false);
    expect(validateRucOrCedula(`${CEDULA}000`).valid).toBe(false);
  });
});

describe('fechas', () => {
  it('una fecha SIN hora ya es de calendario: no se corre un día (medianoche UTC sería el día anterior en Guayaquil)', () => {
    expect(calendarDay('2026-10-12', 'America/Guayaquil')).toBe('2026-10-12');
    expect(localDateOf('2026-10-12', 'America/Guayaquil')).toBe('2026-10-11'); // lo que habría pasado
  });

  it('un instante con hora se convierte a la zona de la organización', () => {
    expect(calendarDay('2026-10-21T03:00:00.000Z', 'America/Guayaquil')).toBe('2026-10-20');
    expect(calendarDay('2026-10-21T15:00:00.000Z', 'America/Guayaquil')).toBe('2026-10-21');
  });

  it('nada o basura no es una fecha', () => {
    expect(calendarDay(null, 'America/Guayaquil')).toBeNull();
    expect(calendarDay('no-es-fecha', 'America/Guayaquil')).toBeNull();
  });

  it('límites del periodo: inicio, primer día del mes siguiente (diciembre cruza el año) y último día', () => {
    expect(periodStart('2026-10')).toBe('2026-10-01');
    expect(periodEnd('2026-10')).toBe('2026-11-01');
    expect(periodEnd('2026-12')).toBe('2027-01-01');
    expect(periodLastDay('2028-02')).toBe('2028-02-29');
    expect(dayInPeriod('2026-10-31', '2026-10')).toBe(true);
    expect(dayInPeriod('2026-11-01', '2026-10')).toBe(false);
  });
});

describe('terceros', () => {
  it('normaliza el tipo de identificación a código SRI sin inventar uno', () => {
    expect(normalizeIdentificationType('RUC')).toBe('04');
    expect(normalizeIdentificationType('cedula')).toBe('05');
    expect(normalizeIdentificationType('PASAPORTE')).toBe('06');
    expect(normalizeIdentificationType('EXTERIOR')).toBe('08');
    expect(normalizeIdentificationType('05')).toBe('05');
    expect(normalizeIdentificationType('algo raro')).toBeNull();
    expect(normalizeIdentificationType(null)).toBeNull();
  });

  it('consumidor final es válido tal cual; un pasaporte no lleva dígito verificador; un RUC malo se marca', () => {
    expect(checkParty({ type: '07', identification: '9999999999999', name: null })).toEqual([]);
    expect(checkParty({ type: '06', identification: 'AB123456', name: 'Extranjero' })).toEqual([]);
    expect(checkParty({ type: '05', identification: '1710034066', name: 'X' }).map((i) => i.problem)).toEqual(['INVALID_PARTY_ID']);
    expect(checkParty({ type: '04', identification: null, name: 'X' }).map((i) => i.problem)).toEqual(['MISSING_PARTY_ID']);
    expect(checkParty({ type: null, identification: CEDULA, name: 'X' }).map((i) => i.problem)).toEqual(['MISSING_PARTY_ID_TYPE']);
  });
});

describe('hash del contenido', () => {
  it('no depende del orden de las claves, en ningún nivel', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [{ y: 1, x: 2 }] } })).toBe(canonicalJson({ a: { c: [{ x: 2, y: 1 }], d: 2 }, b: 1 }));
  });

  // Regresión: `JSON.stringify(obj, Object.keys(obj).sort())` usa la lista de claves como filtro y descartaba todo lo anidado.
  it('dos contenidos con distinto detalle anidado dan hashes distintos', () => {
    const a = { periodo: '2026-10', compras: [{ ivaCents: 100 }] };
    const b = { periodo: '2026-10', compras: [{ ivaCents: 999 }] };
    expect(contentHash(a)).not.toBe(contentHash(b));
    expect(contentHash(a)).toBe(contentHash({ compras: [{ ivaCents: 100 }], periodo: '2026-10' }));
  });
});

describe('casilleros manuales', () => {
  it('solo existen los que declara cada anexo', () => {
    expect(() => validateManualField('f104', 'inventado', 1)).toThrow(ValidationError);
    expect(() => validateManualField('ats', 'ajustes', 1)).toThrow(ValidationError);
    expect(() => validateManualField('f104', 'ajustes', -50)).not.toThrow(); // los ajustes pueden restar
  });

  it('respeta los rangos: el factor va de 0 a 10000 puntos básicos y los créditos no son negativos', () => {
    expect(() => validateManualField('f104', 'factor_proporcionalidad_bps', 10_001)).toThrow(ValidationError);
    expect(() => validateManualField('f104', 'factor_proporcionalidad_bps', 5_000)).not.toThrow();
    expect(() => validateManualField('f104', 'credito_anterior', -1)).toThrow(ValidationError);
    expect(() => validateManualField('f104', 'ajustes', 1.5)).toThrow(ValidationError);
  });

  it('sin valor del contador se usa el predeterminado: el factor es 100 %, no 1 %', () => {
    expect(manualValue('f104', 'factor_proporcionalidad_bps', new Map())).toBe(10_000);
    expect(manualValue('f104', 'credito_anterior', new Map([['credito_anterior', 500]]))).toBe(500);
  });
});

describe('CSV', () => {
  it('neutraliza fórmulas en textos pero no en números (un saldo negativo es un número)', () => {
    expect(csvCell('=SUMA(A1)')).toBe("'=SUMA(A1)");
    expect(csvCell('+593')).toBe("'+593");
    expect(csvCell(-1250)).toBe('-1250');
    expect(csvCell('Hola, "mundo"')).toBe('"Hola, ""mundo"""');
    expect(toCsv([['a', 1], ['b', null]])).toBe('a,1\r\nb,\r\n');
  });

  it('el 103 muestra los importes con dos decimales y su total', () => {
    const csv = buildF103Csv({ periodo: '2026-10', totalesPorConcepto: { '312': { baseCents: 300_00, valorRetenidoCents: 3_00, porcentajes: [1], retenciones: 2, casillero: null } } });
    expect(csv).toContain('312,,1,2,300.00,3.00');
    expect(csv).toContain('TOTAL,,,,300.00,3.00');
  });
});
