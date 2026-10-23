import { AtsSchemaPendingError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { buildCsvFor } from '../../domain/report-csv.js';
import type { UnitOfWorkGateway } from '../../domain/reporting.js';
import { taxAnnexExportedEvent } from '../events.js';
import { inTransaction } from './transaction.js';

export interface ExportResult {
  /** Contenido sin BOM: lo antepone quien lo sirve (es cosa del archivo, no de las filas). */
  content: string;
  fileName: string;
}

export class ExportRunUseCase {
  constructor(private readonly uow: UnitOfWorkGateway) {}

  async execute(params: { organizationId: string; runId: string; format: 'csv' | 'xml'; exportedBy: string }): Promise<ExportResult> {
    const { organizationId, runId, format, exportedBy } = params;

    return inTransaction(this.uow, async (uow) => {
      const run = await uow.taxAnnexRuns.findById(organizationId, runId);
      if (!run) throw new NotFoundError('No existe esa versión del anexo.');

      if (format === 'xml') {
        if (run.annex !== 'ats') throw new ValidationError([{ field: 'format', message: 'Solo el ATS se exporta en XML.' }]);
        // Sin el esquema oficial (XSD) no se puede comprobar que el XML sea válido, y el SRI rechazaría uno armado de memoria.
        throw new AtsSchemaPendingError();
      }

      const content = buildCsvFor(run.annex, run.contentJson);
      // La descarga queda en la bitácora en la MISMA transacción: son datos tributarios de la organización.
      await uow.outbox.add(taxAnnexExportedEvent({ organizationId, runId: run.id, annex: run.annex, period: run.period, version: run.version, format, exportedBy }));
      return { content, fileName: `${run.annex.toUpperCase()}_${run.period.replace('-', '')}_v${run.version}.csv` };
    });
  }
}
