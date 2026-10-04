import type { Refusal, RefusalEnvelope } from '@forge/contracts';
import type { Context } from 'hono';

export type { Refusal, RefusalEnvelope };

export class RefusalError extends Error {
  constructor(
    readonly refusals: readonly Refusal[],
    readonly fallbackCode: string,
  ) {
    super(refusals.map((r) => `${r.code}: ${r.detail}`).join('; '));
    this.name = 'RefusalError';
  }
}

/** The body `refused` answers 422 and `lib/tool.ts:refusedAnswer` returns. */
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

/**
 * A route's answer to refusals a service returned: 422 in the one envelope, under the module's
 * fallback code when the refusals carry more than one code.
 */
export function refused<C extends string>(
  c: Context,
  refusals: readonly Refusal[],
  fallbackCode: C,
) {
  return c.json(refusalEnvelope(refusals, fallbackCode), 422);
}

/**
 * A module's typed thrower: `const refuse = refuser<ReleaseRefusalCode>('RELEASE_REFUSED')`, then
 * `throw refuse('RELEASE_POOL_EMPTY', detail)`. Both doors answer it 422 in the envelope.
 */
export function refuser<C extends string>(fallbackCode: C) {
  return (code: C, detail: string, path = ''): RefusalError =>
    new RefusalError([{ code, path, detail }], fallbackCode);
}

/** A thrown refusal, optionally naming one of its codes. */
export function isRefusal(err: unknown, code?: string): err is RefusalError {
  return (
    err instanceof RefusalError && (code === undefined || err.refusals.some((r) => r.code === code))
  );
}

/** The code a thrown refusal answers under, or null for anything else. */
export function refusalCodeOf(err: unknown): string | null {
  return err instanceof RefusalError
    ? refusalEnvelope(err.refusals, err.fallbackCode).error.code
    : null;
}
