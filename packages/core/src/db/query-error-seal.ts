import { sealQueryError } from '@forge/observability';
import { PgPreparedQuery } from 'drizzle-orm/pg-core';
import { PostgresJsSession, PostgresJsTransaction } from 'drizzle-orm/postgres-js';

/** Every prepared statement fails in `queryWithCache`; a deferred constraint fails at `COMMIT`. */
const DOORS = [
  [PgPreparedQuery.prototype, 'queryWithCache'],
  [PostgresJsSession.prototype, 'transaction'],
  [PostgresJsTransaction.prototype, 'transaction'],
] as const;

const SEALED = Symbol.for('forge.queryErrorSeal');

type Door = Record<string, unknown>;
type Method = ((...args: unknown[]) => Promise<unknown>) & { [SEALED]?: true };

/** Seals what a failed statement or transaction throws; a missing door refuses (ISS-1383). */
export function installQueryErrorSeal(
  doors: ReadonlyArray<readonly [object, string]> = DOORS,
): void {
  for (const [proto, name] of doors) {
    const door = proto as Door;
    const original = door[name] as Method | undefined;
    if (typeof original !== 'function') {
      throw new Error(
        `installQueryErrorSeal: drizzle-orm has no ${name} on ${proto.constructor.name}, so a failed query's bound values would reach every copy of its message; re-derive the seal for this drizzle before upgrading`,
      );
    }
    if (original[SEALED]) continue;
    const sealed = async function (this: unknown, ...args: unknown[]) {
      try {
        return await original.apply(this, args);
      } catch (err) {
        throw sealQueryError(err);
      }
    };
    Object.defineProperty(sealed, SEALED, { value: true });
    door[name] = sealed;
  }
}
