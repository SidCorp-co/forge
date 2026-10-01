// A release verification's window, passed in moments instead of waited out: project-v1 declares
// no `timeoutSeconds` or `stableReads`, so every verification waits 300 s with 5 s between reads.

import { vi } from 'vitest';

const VERIFY_WAIT_MS = 5_000;

/**
 * Until the returned function runs, each 5 s wait `verifyDeployed` makes between two reads is
 * taken at once and `Date.now` moves on by it, so the loop sees its window pass on its own terms:
 * a probe that confirms does so in two reads, and one that never does closes red at 300 s. Every
 * other timer and clock reading keeps real time, apart from the time those waits added.
 */
export function collapseProbeWaits(): () => void {
  const realNow = Date.now.bind(Date);
  const realSetTimeout = globalThis.setTimeout;
  let gained = 0;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + gained);
  const timers = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    fn: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    if (ms === VERIFY_WAIT_MS && new Error().stack?.includes('release-batch/verify.')) {
      gained += VERIFY_WAIT_MS;
      return realSetTimeout(fn, 0, ...args);
    }
    return realSetTimeout(fn, ms, ...args);
  }) as typeof setTimeout);
  return () => {
    timers.mockRestore();
    clock.mockRestore();
  };
}
