import { sealQueryError } from '@forge/observability';
import { PgPreparedQuery } from 'drizzle-orm/pg-core';
import { PostgresJsSession, PostgresJsTransaction } from 'drizzle-orm/postgres-js';

/**
 * Where a failed statement's error leaves drizzle: every prepared statement runs through
 * `queryWithCache`, and a transaction's `BEGIN`, `COMMIT` and savepoints go to the driver from
 * `transaction` directly, so a deferred constraint fails there. All three are drizzle-internal.
 */
const DOORS = [
  [PgPreparedQuery.prototype, 'queryWithCache'],
  [PostgresJsSession.prototype, 'transaction'],
  [PostgresJsTransaction.prototype, 'transaction'],
] as const;

const SEALED = Symbol.for('forge.queryErrorSeal');

type Door = Record<string, unknown>;
type Method = ((...args: unknown[]) => Promise<unknown>) & { [SEALED]?: true };

/**
 * Seal every error a failed statement or transaction throws through drizzle, so its message, its
 * stack and its enumerable fields carry no bound value to whatever copies them (ISS-1383). Once per
 * process; a drizzle that no longer has one of the doors refuses here rather than running unsealed.
 */
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
