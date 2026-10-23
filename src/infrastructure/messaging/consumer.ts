import { EventHandler, InboxConsumer } from '@facturero/outbox-relay';
import type { Sequelize } from 'sequelize';
import {
  HandleBillPostedUseCase,
  HandleBillVoidedUseCase,
  HandleInvoiceIssuedUseCase,
  HandleInvoiceVoidedUseCase,
  HandleWithholdingIssuedUseCase,
  type HandlerDeps,
} from '../../application/use-cases/event-handlers.js';
import type { BillPostedPayload, BillVoidedPayload, InvoiceIssuedPayload, InvoiceVoidedPayload, WithholdingIssuedPayload } from '../../domain/events.js';

/**
 * Eventos que consume reporting-service (ver asyncapi.yaml).
 *
 * Facturación (`billing.invoice.*`): ventas, notas de crédito y de débito, anulaciones. Compras (`purchasing.bill.*`): facturas de compra
 * contabilizadas y anuladas. Fiscal (`fiscal.ec.withholding.issued`): retenciones autorizadas.
 *
 * NO se suscribe a `plugin.activated|deactivated` a propósito: al desactivar el módulo el gateway ya oculta la pantalla, y si dejara de
 * consumir, al reactivarlo los anexos saldrían incompletos. Los datos se conservan; lo que se apaga es la vía de entrada.
 */
export const CONSUMED_BINDINGS = [
  'billing.invoice.issued',
  'billing.invoice.voided',
  'purchasing.bill.posted',
  'purchasing.bill.voided',
  'fiscal.ec.withholding.issued',
] as const;

export function buildEventHandlers(deps: HandlerDeps): EventHandler[] {
  const invoiceIssued = new HandleInvoiceIssuedUseCase(deps);
  const invoiceVoided = new HandleInvoiceVoidedUseCase(deps);
  const billPosted = new HandleBillPostedUseCase(deps);
  const billVoided = new HandleBillVoidedUseCase(deps);
  const withholdingIssued = new HandleWithholdingIssuedUseCase(deps);

  const log = (label: string) => (result: { outcome: string; reason?: string }) => {
    if (result.outcome === 'skipped') console.info(`[reporting-service] ${label} omitido: ${result.reason}`);
  };

  return [
    { eventType: 'billing.invoice.issued', handle: async (payload: unknown) => log('comprobante de venta')(await invoiceIssued.execute(payload as InvoiceIssuedPayload)) },
    { eventType: 'billing.invoice.voided', handle: async (payload: unknown) => log('anulación de venta')(await invoiceVoided.execute(payload as InvoiceVoidedPayload)) },
    { eventType: 'purchasing.bill.posted', handle: async (payload: unknown) => log('factura de compra')(await billPosted.execute(payload as BillPostedPayload)) },
    { eventType: 'purchasing.bill.voided', handle: async (payload: unknown) => log('anulación de compra')(await billVoided.execute(payload as BillVoidedPayload)) },
    { eventType: 'fiscal.ec.withholding.issued', handle: async (payload: unknown) => log('retención')(await withholdingIssued.execute(payload as WithholdingIssuedPayload)) },
  ];
}

export async function startEventConsumers(params: { sequelize: Sequelize; rabbitmqUrl: string; exchange: string; queue: string; handlers: EventHandler[] }): Promise<void> {
  const consumer = new InboxConsumer({
    sequelize: params.sequelize,
    rabbitmqUrl: params.rabbitmqUrl,
    exchange: params.exchange,
    queue: params.queue,
    bindings: [...CONSUMED_BINDINGS],
    handlers: params.handlers,
  });
  await consumer.start();
  console.log('[reporting-service] consumidores de eventos activos');
}
