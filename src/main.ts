import './infrastructure/telemetry/otel.js';
import { serve } from '@hono/node-server';
import { OutboxRelay } from '@facturero/outbox-relay';
import { config } from './infrastructure/config.js';
import { sequelize } from './infrastructure/persistence/sequelize.js';
import './infrastructure/persistence/models.js';
import { readOnlyRepositories, SequelizeUnitOfWorkFactory } from './infrastructure/persistence/repositories.js';
import { HttpAccountingCatalog, HttpOrganizationCatalog } from './infrastructure/catalogs/http-catalogs.js';
import { buildEventHandlers, startEventConsumers } from './infrastructure/messaging/consumer.js';
import { ExportRunUseCase } from './application/use-cases/export-run.js';
import { GenerateAnnexUseCase } from './application/use-cases/generate-annex.js';
import { GetReconciliationUseCase } from './application/use-cases/get-reconciliation.js';
import { ListManualInputsUseCase, SetManualInputUseCase } from './application/use-cases/manual-input-use-case.js';
import { GetRunUseCase, ListDocumentsUseCase, ListRunsUseCase } from './application/use-cases/read-use-cases.js';
import { createApp } from './interface/http/app.js';

async function main(): Promise<void> {
  // NO se llama a `sequelize.sync()`: la migración (initContainer reporting-migrate) es la fuente de verdad del esquema.
  await sequelize.authenticate();

  let relay: OutboxRelay | undefined;
  const uow = new SequelizeUnitOfWorkFactory((tx) => relay?.attachToTransaction(tx));
  const reads = readOnlyRepositories;
  const clock = () => new Date();
  const accounting = new HttpAccountingCatalog(config.ACCOUNTING_SERVICE_URL);
  const organizations = new HttpOrganizationCatalog(config.ORGANIZATION_SERVICE_URL);

  const app = createApp({
    corsOrigin: config.CORS_ORIGIN,
    useCases: {
      listRuns: new ListRunsUseCase(reads),
      getRun: new GetRunUseCase(reads),
      generate: new GenerateAnnexUseCase({ uow, organizations, clock }),
      exportRun: new ExportRunUseCase(uow),
      reconciliation: new GetReconciliationUseCase(reads, accounting),
      setManualInput: new SetManualInputUseCase({ uow, clock }),
      listManualInputs: new ListManualInputsUseCase(uow),
      listDocuments: new ListDocumentsUseCase(reads),
    },
  });

  serve({ fetch: app.fetch, port: config.PORT });
  console.log(`[reporting-service] corriendo en puerto ${config.PORT}`);

  if (config.RABBITMQ_URL) {
    relay = new OutboxRelay({ sequelize, rabbitmqUrl: config.RABBITMQ_URL, exchange: 'crm.events' });
    await relay.start();
    console.log('[reporting-service] outbox relay activo');

    await startEventConsumers({
      sequelize,
      rabbitmqUrl: config.RABBITMQ_URL,
      exchange: 'crm.events',
      queue: 'reporting-service.events',
      handlers: buildEventHandlers({ uow, timezone: config.ORG_TIMEZONE, clock }),
    });
  } else {
    console.warn('[reporting-service] RABBITMQ_URL no configurado: los eventos NO se publican ni consumen');
  }
}

main().catch((err) => {
  console.error('[reporting-service] error al iniciar:', err);
  process.exit(1);
});
