import { createHash } from 'node:crypto';

/**
 * JSON con las claves ordenadas en TODOS los niveles. Dos contenidos iguales dan el mismo texto sin importar en qué orden se armaron.
 *
 * (`JSON.stringify(obj, Object.keys(obj).sort())` NO sirve para esto: la lista de claves actúa como filtro en cada nivel y descarta
 * todo lo anidado cuyo nombre no esté en el primero, así que dos contenidos distintos podían dar el mismo hash.)
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
