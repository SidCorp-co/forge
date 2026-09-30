import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { parseWriteEnvelope, type WriteEnvelope } from './documents.js';

export interface NamedRefusal {
  code: string;
  path: string;
  detail: string;
}

export function refused(c: Context, refusals: readonly NamedRefusal[]) {
  const codes = [...new Set(refusals.map((r) => r.code))];
  const code = codes.length === 1 && codes[0] ? codes[0] : 'CONFIG_REFUSED';
  return c.json(
    {
      error: {
        code,
        message: `refused, nothing written: ${refusals.map((r) => `${r.code} at ${r.path || '/'}`).join('; ')}`,
        refusals,
      },
    },
    422,
  );
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
