/**
 * The one refusal envelope (docs/conventions/domain-entities.md "Refusals"): a write refused by name
 * answers `{ error: { code, message, refusals } }` with nothing written — at the REST door through
 * `project-config/respond.ts:refused` (422), at the MCP door through `mcp/tools/lib.ts:refusedAnswer`.
 */

import type { Refusal, RefusalEnvelope } from '@forge/contracts';

export type { Refusal, RefusalEnvelope };

export function refusalEnvelope(
  refusals: readonly Refusal[],
  fallbackCode: string,
): RefusalEnvelope {
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
