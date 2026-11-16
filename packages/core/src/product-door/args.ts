import type { z } from 'zod';
import { type Refusal, RefusalError, requestRefusals } from '../lib/refusal.js';

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

/** A service's outcome as the tool answers it: the value, or its refusals thrown in the envelope. */
export function settled<O extends { ok: true } | { ok: false; refusals: readonly Refusal[] }>(
  outcome: O,
  fallback: string,
): Extract<O, { ok: true }> {
  if (!outcome.ok) throw new RefusalError(outcome.refusals, fallback);
  return outcome as Extract<O, { ok: true }>;
}
