import { zValidator } from '@hono/zod-validator';
import type { Context } from 'hono';
import type { ZodTypeAny } from 'zod';
import { ValidationError } from '../../domain/errors.js';
import type { TaxAnnexFinding, TaxAnnexRun } from '../../domain/reporting.js';
import type { ContextVariables } from './middlewares.js';

export type Vars = { Variables: ContextVariables };
export type Ctx = Context<Vars>;

export const org = (c: Ctx) => c.get('organizationId');
export const user = (c: Ctx) => c.get('userId');

/** Validación con zod que responde 422 con el mismo formato de error que el resto del servicio (en vez del 400 con otro cuerpo por defecto). */
export const validate = <T extends ZodTypeAny>(target: 'param' | 'query' | 'json', schema: T) =>
  zValidator(target, schema, (result) => {
    if (!result.success) {
      throw new ValidationError(result.error.issues.map((i) => ({ field: i.path.join('.') || target, message: i.message })));
    }
  });

/** Un CSV descargable. BOM al inicio: sin él Excel abre el archivo en la codificación equivocada y los acentos se ven mal. */
export const csvResponse = (c: Ctx, file: { content: string; fileName: string }) =>
  c.body(`﻿${file.content}`, 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${file.fileName}"`,
    // Es información tributaria de la organización: que ningún intermediario la guarde.
    'Cache-Control': 'no-store',
  });

/** La corrida sin su contenido: los listados no deben arrastrar el anexo entero de cada versión. */
export const toRunSummary = (r: TaxAnnexRun) => ({
  id: r.id,
  annex: r.annex,
  period: r.period,
  version: r.version,
  contentHash: r.contentHash,
  generatedBy: r.generatedBy,
  generatedAt: r.generatedAt.toISOString(),
  summary: r.summaryJson,
});

export const toRunFull = (r: TaxAnnexRun) => ({ ...toRunSummary(r), content: r.contentJson });

export const toFinding = (f: TaxAnnexFinding) => ({ id: f.id, severity: f.severity, code: f.code, message: f.message, documentId: f.documentId });
