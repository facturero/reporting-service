/** Qué impuesto se retiene: renta (código SRI 1), IVA (2) o ISD (6). */
export type WithholdingTax = 'income' | 'vat' | 'isd';

export interface WithholdingLine {
  tax: WithholdingTax;
  /** Código de la tabla de retenciones del SRI (303, 304, 9, 10…). */
  retentionCode: string;
  baseCents: number;
  /** Porcentaje a retener, con hasta dos decimales. */
  ratePercent: number;
  /** `base × porcentaje`, calculado aquí; nunca lo manda el cliente. */
  amountCents: number;
}