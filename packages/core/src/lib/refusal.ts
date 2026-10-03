/**
 * The one refusal envelope (docs/conventions/domain-entities.md): a domain write refused by name
 * answers `{ error: { code, message, refusals } }` with nothing written, at the REST door
 * (`answerRefusal`, or a thrown `RefusalException` the error handler renders) and at the MCP door
 * (`mcp/tools/lib.ts:refusedAnswer`). The status is read off the codes, never chosen per route.
 */

import type { Refusal, RefusalEnvelope, RefusalStatus } from '@forge/contracts';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

export type { Refusal, RefusalEnvelope, RefusalStatus };

const isForbidden = (code: string) => code.endsWith('_FORBIDDEN');
const isConflict = (code: string) => code.endsWith('_STALE') || code.endsWith('_DECIDED');

/** 403 when every code is who-may-act, 409 when every code says the head or row moved, else 422. */
export function refusalStatus(refusals: readonly Refusal[]): RefusalStatus {
  if (refusals.length === 0) throw new Error('refusalStatus: an empty list refuses nothing');
  if (refusals.every((r) => isForbidden(r.code))) return 403;
  if (refusals.every((r) => isConflict(r.code))) return 409;
  return 422;
}

export function refusalEnvelope(refusals: readonly Refusal[], fallbackCode: string): RefusalEnvelope {
  if (refusals.length === 0) throw new Error('refusalEnvelope: an empty list refuses nothing');
  const codes = [...new Set(refusals.map((r) => r.code))];
  return {
    error: {
      code: codes.length === 1 && codes[0] ? codes[0] : fallbackCode,
      message: `refused, nothing written: ${refusals.map((r) => `${r.code} at ${r.path || '/'}`).join('; ')}`,
      refusals: [...refusals],
    },
  };
}

/** The REST answer to a returned refusal list; `status` is for a document write, which is always 422. */
export function answerRefusal(
  c: Context,
  refusals: readonly Refusal[],
  opts: { fallbackCode: string; status?: RefusalStatus },
) {
  return c.json(refusalEnvelope(refusals, opts.fallbackCode), opts.status ?? refusalStatus(refusals));
}

/**
 * A refusal decided where returning it is not possible, thrown and rendered by
 * `middleware/error.ts:errorHandler` as the same envelope. `cause.details.refusals` keeps the list
 * for an MCP door that catches it (`mcp/tools/ecosystem-side.ts:namedRefusals`).
 */
export class RefusalException extends HTTPException {
  readonly envelope: RefusalEnvelope;
  constructor(status: RefusalStatus, refusals: readonly Refusal[], fallbackCode = 'REFUSED') {
    const envelope = refusalEnvelope(refusals, fallbackCode);
    super(status, {
      message: refusals.map((r) => r.detail).join('; '),
      cause: { code: envelope.error.code, details: { refusals: envelope.error.refusals } },
    });
    this.envelope = envelope;
  }
}
