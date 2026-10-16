import type { z } from 'zod';
import { RefusalError, requestRefusals } from '../lib/refusal.js';

/** A tool's arguments read against its schema; a mismatch is refused naming each field at its path. */
export function parseArgs<S extends z.ZodTypeAny>(
  schema: S,
  args: unknown,
  shape: string,
): z.infer<S> {
  const parsed = schema.safeParse(args);
  if (parsed.success) return parsed.data;
  throw new RefusalError(requestRefusals('BAD_REQUEST', shape, parsed.error), 'BAD_REQUEST', shape);
}

/** The fields one action needs, refused by name where the call left one out. */
export function need<T extends Record<string, unknown>, K extends keyof T & string>(
  input: T,
  action: string,
  ...fields: K[]
): T & { [P in K]-?: NonNullable<T[P]> } {
  const missing = fields.filter((f) => input[f] === undefined || input[f] === null);
  if (missing.length > 0) {
    throw new RefusalError(
      missing.map((f) => ({
        code: 'BAD_REQUEST',
        path: `/${f}`,
        detail: `action ${action} needs ${f}`,
      })),
      'BAD_REQUEST',
    );
  }
  return input as T & { [P in K]-?: NonNullable<T[P]> };
}
