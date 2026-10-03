import type { Refusal, RefusalEnvelope } from '@forge/contracts';

export type { Refusal, RefusalEnvelope };

export class RefusalError extends Error {
  constructor(
    readonly refusals: readonly Refusal[],
    readonly fallbackCode: string,
  ) {
    super(refusals.map((r) => r.code).join(', '));
    this.name = 'RefusalError';
  }
}

/** The body `respond.ts:refused` answers 422 and `mcp/tools/lib.ts:refusedAnswer` returns. */
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
