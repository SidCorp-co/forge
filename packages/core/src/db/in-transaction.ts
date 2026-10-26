import { is } from 'drizzle-orm';
import { PgTransaction } from 'drizzle-orm/pg-core';

/**
 * Rethrows `err` when `handle` is a transaction. A statement that failed inside one has already
 * ended it, whatever the catch around it decides: Postgres aborts the transaction on any error,
 * and a connection the server ended refuses every later statement with the error it was closed
 * with (`patches/postgres@3.4.9.patch`). A fallback taken there runs on into statements that can
 * only fail, so it is taken only on the pool.
 */
export function rethrowInTransaction(err: unknown, handle: unknown): void {
  if (is(handle, PgTransaction)) throw err;
}
