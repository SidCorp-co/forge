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
