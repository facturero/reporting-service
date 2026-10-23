import type { UnitOfWork, UnitOfWorkGateway } from '../../domain/reporting.js';

/** Corre `work` dentro de una transacción: confirma si termina, deshace si lanza. */
export async function inTransaction<T>(
  gateway: UnitOfWorkGateway,
  work: (uow: UnitOfWork) => Promise<T>,
  options?: { readCommitted?: boolean },
): Promise<T> {
  const uow = await gateway.begin(options);
  try {
    const result = await work(uow);
    await uow.commit();
    return result;
  } catch (err) {
    await uow.rollback();
    throw err;
  }
}

/** Un UNIQUE de MySQL que no se anticipó (dos entregas del mismo evento a la vez) no es un fallo: es un duplicado. */
export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: string; parent?: { code?: string }; original?: { code?: string } };
  if (e.name === 'SequelizeUniqueConstraintError') return true;
  const code = e.parent?.code ?? e.original?.code;
  return code === 'ER_DUP_ENTRY' || code === 'ER_DUP_KEY';
}

const MAX_ATTEMPTS = 3;

/**
 * Repite el trabajo entero si choca con un UNIQUE. Dos eventos del MISMO documento pueden procesarse a la vez (la emisión y la anulación
 * de una factura): el que pierde la carrera choca al insertar. Responder «duplicado» y seguir PERDERÍA sus datos si lo que ganó fue un
 * registro provisional (la anulación llegó antes y creó un comprobante vacío). Se vuelve a empezar con una transacción nueva: la
 * lectura ya ve lo que el otro confirmó y lo completa o lo trata como duplicado de verdad.
 */
export async function retryOnUnique<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (err) {
      if (isUniqueViolation(err) && attempt < MAX_ATTEMPTS) continue;
      throw err;
    }
  }
}
