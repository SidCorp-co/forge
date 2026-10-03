import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { type Refusal, refusalEnvelope } from '../lib/refusal.js';
import { parseWriteEnvelope, type WriteEnvelope } from './documents.js';

export type { Refusal as NamedRefusal } from '../lib/refusal.js';

/** Every write refused by name answers 422 in the one envelope (domain-entities.md "Refusals"). */
export function refused(c: Context, refusals: readonly Refusal[]) {
  return c.json(refusalEnvelope(refusals, 'CONFIG_REFUSED'), 422);
}

export function envelopeOf(raw: unknown): WriteEnvelope {
  const envelope = parseWriteEnvelope(raw);
  if (!envelope.ok) {
    throw new HTTPException(400, {
      message: envelope.message,
      cause: { code: 'CONFIG_WRITE_SHAPE' },
    });
  }
  return envelope.value;
}
