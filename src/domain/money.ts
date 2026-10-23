/** Suma dos importes en centavos (enteros). */
export function addCents(a: number, b: number): number {
  return a + b;
}

/** Resta dos importes en centavos. */
export function subCents(a: number, b: number): number {
  return a - b;
}

/** Multiplica centavos por un factor decimal (ej. porcentaje / 100) y redondea a centavo. */
export function mulCents(cents: number, factor: number): number {
  return Math.round(cents * factor);
}

/** Divide centavos entre un divisor entero y redondea a centavo. */
export function divCents(cents: number, divisor: number): number {
  return Math.round(cents / divisor);
}

/** Porcentaje a factor (ej. 15 → 0.15). */
export function pctToFactor(pct: number): number {
  return pct / 100;
}

/** Redondea a centavo (entero). */
export function roundCents(value: number): number {
  return Math.round(value);
}

/** Formatea centavos como string con 2 decimales. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${sign}${whole}.${String(frac).padStart(2, '0')}`;
}

/** Parsea string "123.45" a centavos (12345). */
export function parseCents(str: string): number {
  const match = str.match(/^(-?)\s*(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error(`Importe inválido: ${str}`);
  const sign = match[1] === '-' ? -1 : 1;
  const whole = parseInt(match[2], 10);
  const frac = match[3] ? parseInt(match[3].padEnd(2, '0').slice(0, 2), 10) : 0;
  return sign * (whole * 100 + frac);
}