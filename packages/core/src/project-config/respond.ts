import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { answerRefusal, type Refusal } from '../lib/refusal.js';
import { parseWriteEnvelope, type WriteEnvelope } from './documents.js';

export type { Refusal as NamedRefusal } from '../lib/refusal.js';

/** A document write (`{ baseRevision, document }`) is refused 422 whatever the code; web reads it so (`documentRefusals`). */
export function refused(c: Context, refusals: readonly Refusal[]) {
  return answerRefusal(c, refusals, { fallbackCode: 'CONFIG_REFUSED', status: 422 });
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
