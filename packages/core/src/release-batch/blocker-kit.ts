import {
  blockerHttpStatus,
  type ReleaseBlocker,
  type ReleaseBlockerCode,
  releaseBlockerSentence,
} from './blocker-sentences.js';

export function blocker(
  code: ReleaseBlockerCode,
  details?: Record<string, unknown>,
  scope?: 'roster',
): ReleaseBlocker {
  return {
    code,
    httpStatus: blockerHttpStatus(code),
    message: releaseBlockerSentence(code, details),
    evaluated: code !== 'RELEASE_CHECK_UNEVALUATED',
    ...(details ? { details } : {}),
    ...(scope ? { scope } : {}),
  };
}

/** One check, and the blocker that stands in for it when it cannot be run. */
export async function evaluate<T>(
  check: string,
  read: () => Promise<T>,
  out: ReleaseBlocker[],
): Promise<T | undefined> {
  const { value, failure } = await attempt(check, read);
  if (failure) out.push(failure);
  return value;
}

/** The same read, with its failure handed back rather than appended. */
export async function attempt<T>(
  check: string,
  read: () => Promise<T>,
): Promise<{ value: T | undefined; failure: ReleaseBlocker | null }> {
  try {
    return { value: await read(), failure: null };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { value: undefined, failure: blocker('RELEASE_CHECK_UNEVALUATED', { check, detail }) };
  }
}
