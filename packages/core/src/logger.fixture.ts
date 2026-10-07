// ISS-1383 — what the logger's tests log: failed queries, driver refusals and values that render themselves.

import { DrizzleQueryError } from 'drizzle-orm/errors';
import type { Logger } from 'pino';
import { createLogger } from './logger.js';
export const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c3ludGhldGlj$bG9nZ2VyLWhhc2g';
export const EMAIL = 'dup@example.test';

export function failedInsert(): DrizzleQueryError {
  const driver = Object.assign(
    new Error('duplicate key value violates unique constraint "users_email_unique"'),
    {
      severity: 'ERROR',
      code: '23505',
      constraint_name: 'users_email_unique',
      detail: `Key (email)=(${EMAIL}) already exists.`,
    },
  );
  return new DrizzleQueryError(
    'insert into "users" ("email", "password_hash") values ($1, $2)',
    [EMAIL, HASH],
    driver,
  );
}

/** A proxy whose every read throws a failed query, its bound values in the message. */
export function hostile(): object {
  const trap = () => {
    throw failedInsert();
  };
  return new Proxy(
    {},
    { get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap, has: trap, ownKeys: trap },
  );
}

/** `answer` as a getter's answer, under `reading`. */
export function answering(answer: object): object {
  return Object.defineProperty({}, 'reading', { get: () => answer, enumerable: true });
}

/** A proxy that throws on any use at all, `Array.isArray` included. */
export function revoked(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

export function capture(): { lines: string[]; log: Logger } {
  const lines: string[] = [];
  const log = createLogger({ level: 'debug' }, { write: (s: string) => lines.push(s) });
  return { lines, log };
}

/** A driver error as postgres-js throws it, its bound values non-enumerable as there. */
export function refusal(message: string, fields: Record<string, unknown>, bound: unknown[]): Error {
  const pg = Object.assign(new Error(message), { severity: 'ERROR', ...fields });
  Object.defineProperty(pg, 'parameters', { value: bound, enumerable: false });
  return pg;
}

/** Each way a value's text reaches a line through what a serializer calls, not a field it holds. */
export const SERIALIZER_HOOKS: [string, (text: string) => unknown][] = [
  ['its own toJSON', (text) => ({ toJSON: () => text })],
  ['a toJSON it inherits', (text) => Object.create({ toJSON: () => text })],
  [
    'a getter',
    (text) => Object.defineProperty({}, 'reason', { get: () => text, enumerable: true }) as unknown,
  ],
  [
    "a boxed string's Symbol.toPrimitive",
    (text) => Object.assign(new String('ordinary'), { [Symbol.toPrimitive]: () => text }),
  ],
  [
    "a boxed string's toString",
    (text) => Object.assign(new String('ordinary'), { toString: () => text }),
  ],
  ['a field of a tagged object', (text) => ({ [Symbol.toStringTag]: 'Reading', reason: text })],
];

/** A driver message only the error beside it can tell holds a bound value: no anchor names it. */
export function relationRefusal(): Error {
  return refusal('relation "zq" does not exist', { code: '42P01' }, ['zq']);
}
