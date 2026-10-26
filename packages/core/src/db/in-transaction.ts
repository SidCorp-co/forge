import { is } from 'drizzle-orm';
import { PgTransaction } from 'drizzle-orm/pg-core';

export function rethrowInTransaction(err: unknown, handle: unknown): void {
  if (is(handle, PgTransaction)) throw err;
}
