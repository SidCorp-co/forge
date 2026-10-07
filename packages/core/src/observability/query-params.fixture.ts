// ISS-1383 — failed queries and driver refusals, as drizzle and postgres-js throw them.

import { DrizzleQueryError } from 'drizzle-orm/errors';

export const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c3ludGhldGlj$c3ludGhldGljLWhhc2g';
export const EMAIL = 'dup@example.test';
export const STATEMENT = 'insert into "users" ("email", "password_hash") values ($1, $2)';

export function driverError(message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { severity: 'ERROR', ...extra });
}

export function duplicate(): DrizzleQueryError {
  return new DrizzleQueryError(
    STATEMENT,
    [EMAIL, HASH],
    driverError('duplicate key value violates unique constraint "users_email_unique"', {
      code: '23505',
      constraint_name: 'users_email_unique',
      detail: `Key (email)=(${EMAIL}) already exists.`,
    }),
  );
}

/** A driver error as postgres-js throws it: its bound values ride non-enumerable, as there. */
export function pgRefusal(
  message: string,
  fields: Record<string, unknown>,
  bound: unknown[],
): Error {
  const pg = Object.assign(new Error(message), { severity: 'ERROR', ...fields });
  Object.defineProperty(pg, 'parameters', { value: bound, enumerable: false });
  return pg;
}
