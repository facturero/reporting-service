import { randomUUID } from 'node:crypto';
import { validateManualField } from '../../domain/manual-fields.js';
import type { AnnexType, TaxAnnexManualInput, UnitOfWorkGateway } from '../../domain/reporting.js';
import { ValidationError } from '../../domain/errors.js';
import { manualInputSetEvent } from '../events.js';
import type { Clock } from '../ports.js';
import { inTransaction } from './transaction.js';

export interface SetManualInputDeps {
  uow: UnitOfWorkGateway;
  clock: Clock;
}

export interface ListedManualInput extends TaxAnnexManualInput {}

export class SetManualInputUseCase {
  constructor(private readonly deps: SetManualInputDeps) {}

  /**
   * Guarda (o reemplaza) un casillero manual. NO regenera el anexo: el contador puede ajustar varios y luego generar UNA versión nueva
   * con todos. El valor anterior viaja en el evento para que la bitácora muestre qué cambió.
   */
  async execute(params: { organizationId: string; annex: AnnexType; period: string; fieldCode: string; amountCents: number; setBy: string }): Promise<TaxAnnexManualInput> {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(params.period)) throw new ValidationError([{ field: 'period', message: 'El periodo debe ser AAAA-MM.' }]);
    validateManualField(params.annex, params.fieldCode, params.amountCents);

    return inTransaction(this.deps.uow, async (uow) => {
      const previous = (await uow.taxAnnexManualInputs.list(params.organizationId, params.annex, params.period)).find((m) => m.fieldCode === params.fieldCode);
      const input: TaxAnnexManualInput = {
        id: previous?.id ?? randomUUID(),
        organizationId: params.organizationId,
        annex: params.annex,
        period: params.period,
        fieldCode: params.fieldCode,
        amountCents: params.amountCents,
        setBy: params.setBy,
        setAt: this.deps.clock(),
      };
      await uow.taxAnnexManualInputs.upsert(input);
      await uow.outbox.add(
        manualInputSetEvent({
          organizationId: params.organizationId,
          annex: params.annex,
          period: params.period,
          fieldCode: params.fieldCode,
          amountCents: params.amountCents,
          previousCents: previous?.amountCents ?? null,
          setBy: params.setBy,
        }),
      );
      return input;
    });
  }
}

export class ListManualInputsUseCase {
  constructor(private readonly uow: UnitOfWorkGateway) {}

  async execute(organizationId: string, annex: AnnexType, period: string): Promise<TaxAnnexManualInput[]> {
    return inTransaction(this.uow, (uow) => uow.taxAnnexManualInputs.list(organizationId, annex, period));
  }
}
