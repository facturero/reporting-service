import { newDomainEvent, REPORTING_EVENTS, type AnnexType, type DomainEvent, type TaxAnnexRun } from '../domain/reporting.js';

/**
 * Un anexo del SRI se generó (versión nueva). Lo consume audit-log-service. No lleva el contenido del anexo: solo QUÉ, de cuándo y la
 * versión; el detalle se consulta en el propio servicio.
 */
export function taxAnnexGeneratedEvent(params: { run: TaxAnnexRun; triggeredBy: string; errors: number; warnings: number }): DomainEvent {
  const { run } = params;
  return newDomainEvent({
    type: REPORTING_EVENTS.TAX_ANNEX_GENERATED,
    aggregateType: 'tax_annex_run',
    aggregateId: run.id,
    payload: {
      organizationId: run.organizationId,
      runId: run.id,
      annex: run.annex,
      period: run.period,
      version: run.version,
      contentHash: run.contentHash,
      generatedBy: run.generatedBy,
      generatedAt: run.generatedAt.toISOString(),
      errors: params.errors,
      warnings: params.warnings,
    },
  });
}

/** Un anexo se descargó (CSV). Quedan constancia de quién y en qué formato: son datos tributarios de la organización. */
export function taxAnnexExportedEvent(params: { organizationId: string; runId: string; annex: AnnexType; period: string; version: number; format: 'csv' | 'xml'; exportedBy: string }): DomainEvent {
  return newDomainEvent({
    type: REPORTING_EVENTS.TAX_ANNEX_EXPORTED,
    aggregateType: 'tax_annex_run',
    aggregateId: params.runId,
    payload: {
      organizationId: params.organizationId,
      runId: params.runId,
      annex: params.annex,
      period: params.period,
      version: params.version,
      format: params.format,
      exportedBy: params.exportedBy,
    },
  });
}

/** El contador cambió un casillero manual: modifica lo que se declara, así que debe quedar en la bitácora con el valor anterior. */
export function manualInputSetEvent(params: { organizationId: string; annex: AnnexType; period: string; fieldCode: string; amountCents: number; previousCents: number | null; setBy: string }): DomainEvent {
  return newDomainEvent({
    type: REPORTING_EVENTS.TAX_ANNEX_MANUAL_INPUT_SET,
    aggregateType: 'tax_annex_manual_input',
    aggregateId: params.organizationId,
    payload: { ...params },
  });
}
