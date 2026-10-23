/**
 * Convierte ISO (con zona) a fecha local 'AAAA-MM-DD' en la zona dada.
 * La zona afecta qué día cae el timestamp; para documentos del SRI se usa America/Guayaquil.
 */
export function localDateOf(iso: string | Date, tz: string): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  return d.toLocaleDateString('en-CA', { timeZone: tz });
}

/**
 * La fecha de calendario de un valor que puede venir como `AAAA-MM-DD` o como instante ISO con hora.
 *
 * Una fecha SIN hora ya es de calendario y se deja como está: pasarla por `localDateOf` la leería como medianoche UTC y en Guayaquil
 * (UTC-5) caería el día anterior. Solo un instante con hora se convierte a la zona de la organización. `null` si no es una fecha.
 */
export function calendarDay(value: string | null | undefined, tz: string): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return localDateOf(d, tz);
}

/** Inicio de mes 'AAAA-MM' → 'AAAA-MM-01'. */
export function periodStart(period: string): string {
  return `${period}-01`;
}

/** Primer día del mes siguiente 'AAAA-MM' → 'AAAA-MM-01' (límite superior EXCLUSIVO del periodo). */
export function periodEnd(period: string): string {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const nextM = m === 12 ? 1 : m + 1;
  const nextY = m === 12 ? y + 1 : y;
  return `${nextY}-${String(nextM).padStart(2, '0')}-01`;
}

/** Último día del mes 'AAAA-MM' → 'AAAA-MM-DD' (límite superior INCLUSIVO). */
export function periodLastDay(period: string): string {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** Verifica si una fecha 'AAAA-MM-DD' cae dentro del periodo 'AAAA-MM'. */
export function dayInPeriod(day: string, period: string): boolean {
  return day >= periodStart(period) && day < periodEnd(period);
}
