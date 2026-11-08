import { AsyncLocalStorage } from 'node:async_hooks';

const observed = new AsyncLocalStorage<true>();

/**
 * Runs `fn` as a person's read of what waits on them (Needs you, attention): a reading of a
 * platform inside it may be one observed a moment ago and said so
 * (`release-batch/serving-observed.ts`), where every other read reads it afresh.
 */
export function withObservedReads<T>(fn: () => T): T {
  return observed.run(true, fn);
}

/** Whether this code runs inside {@link withObservedReads}. */
export const observedReadsAllowed = (): boolean => observed.getStore() === true;
