import {
  type ReleaseBlocker,
  type ReleaseBlockerCode,
  releaseBlockerSentence,
} from './blocker-sentences.js';
import { reasonOf } from './refuse.js';

export function blocker(
  code: ReleaseBlockerCode,
  details?: Record<string, unknown>,
  scope?: 'roster',
): ReleaseBlocker {
  return {
    code,
    message: releaseBlockerSentence(code, details),
    evaluated: code !== 'RELEASE_CHECK_UNEVALUATED',
    ...(details ? { details } : {}),
    ...(scope ? { scope } : {}),
  };
}

/**
 * One check read into a list of its own, with what it answered: checks a door reads at once still
 * report in the order it refuses in, each list joined in that order (ISS-1070 r17).
 */
export async function collected<T>(
  check: (out: ReleaseBlocker[]) => Promise<T>,
): Promise<{ value: T; out: ReleaseBlocker[] }> {
  const out: ReleaseBlocker[] = [];
  return { value: await check(out), out };
}

/** What a settled read answered, or its failure thrown where it is reached. */
export function settledValue<T>(read: PromiseSettledResult<T>): T {
  if (read.status === 'rejected') throw read.reason;
  return read.value;
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
    return {
      value: undefined,
      failure: blocker('RELEASE_CHECK_UNEVALUATED', { check, detail: reasonOf(err) }),
    };
  }
}
