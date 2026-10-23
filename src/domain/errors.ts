export interface ErrorDetail {
  field: string;
  message: string;
}

export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  readonly details?: ErrorDetail[];

  constructor(message: string, details?: ErrorDetail[]) {
    super(message);
    this.name = new.target.name;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends AppError {
  readonly code = 'VALIDATION_ERROR';
  readonly httpStatus = 422;
  constructor(details: ErrorDetail[], message?: string) {
    super(message ?? (details.map((d) => d.message).join(' ') || 'La petición no es válida.'), details);
  }
}

export class OrganizationContextRequiredError extends AppError {
  readonly code = 'ORG_CONTEXT_REQUIRED';
  readonly httpStatus = 401;
  constructor(message = 'Falta el contexto de organización.') { super(message); }
}

export class UserContextRequiredError extends AppError {
  readonly code = 'USER_CONTEXT_REQUIRED';
  readonly httpStatus = 401;
  constructor(message = 'Falta el contexto de usuario.') { super(message); }
}

export class ForbiddenError extends AppError {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;
  constructor(message = 'Permiso insuficiente.') { super(message); }
}

export class NotFoundError extends AppError {
  readonly code = 'NOT_FOUND';
  readonly httpStatus = 404;
  constructor(message = 'Recurso no encontrado.') { super(message); }
}

/** Se pide algo que depende de un anexo que todavía no se generó para ese periodo. */
export class AnnexNotGeneratedError extends AppError {
  readonly code = 'ANNEX_NOT_GENERATED';
  readonly httpStatus = 409;
  constructor(message = 'Todavía no se generó este anexo para el periodo. Genéralo primero.') { super(message); }
}

/**
 * Un servicio del que depende el cálculo (contabilidad, organización) no respondió. NO es «no hay datos»: dar por cero un saldo que
 * no se pudo consultar haría pasar por cuadrado un anexo que no se pudo comprobar.
 */
export class CatalogUnavailableError extends AppError {
  readonly code = 'CATALOG_UNAVAILABLE';
  readonly httpStatus = 502;
  constructor(message = 'No se pudo consultar otro servicio. Reintenta en un momento.') { super(message); }
}

/**
 * El XML del ATS no se puede generar mientras no esté el esquema oficial (XSD) del SRI en el repositorio: una estructura escrita de
 * memoria que no valida contra el esquema sería rechazada por el SRI y daría falsa tranquilidad.
 */
export class AtsSchemaPendingError extends AppError {
  readonly code = 'ATS_SCHEMA_PENDING';
  readonly httpStatus = 501;
  constructor(message = 'El XML del ATS aún no está disponible: falta el esquema oficial (XSD) del SRI en el servicio. Descarga el CSV mientras tanto.') { super(message); }
}

export class ConcurrentUpdateError extends AppError {
  readonly code = 'CONCURRENT_UPDATE';
  readonly httpStatus = 409;
  constructor(message = 'Otra operación modificó lo mismo a la vez. Vuelve a intentarlo.') { super(message); }
}
