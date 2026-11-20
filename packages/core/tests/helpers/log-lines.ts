// Every call the process's logger is handed, recorded for a test that proves a value was never
// logged. Three ways a logger spy goes blind, each seen on this tree (cleanup be0527ad, debt 3baa93b2):
// - vitest clears every spy's `.mock.calls` before each test (`clearMocks` defaults to true), so a
//   spy installed in a `beforeAll` and read in a test sees nothing logged before that test;
// - pino replaces its level methods whenever `logger.level` is set, dropping any spy on them;
// - `vi.spyOn` on a method already spied returns that spy, so a second wrapper replaces the first's
//   implementation, and one calling the method it found bound calls itself without end.
// Lines go to an array the recorder owns, the wrapper calls on to whatever was there before it, and
// `lines` refuses by name once a level is no longer the recorder's.

import { type Mock, vi } from 'vitest';
import { logger } from '../../src/lib/logger.js';

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
type LevelCall = (...args: unknown[]) => unknown;

export interface LogLines {
  /** Each call as one JSON line, an error by its message; throws if a level stopped recording. */
  readonly lines: readonly string[];
  /** Forgets what was recorded so far; the recording goes on. */
  clear(): void;
}

/** Starts recording every logger call; `vi.restoreAllMocks` (or `mockRestore`) ends it. */
export function recordLogLines(): LogLines {
  const kept: string[] = [];
  const wrappers = new Map<(typeof LEVELS)[number], LevelCall>();
  for (const level of LEVELS) {
    const current = logger[level] as unknown as LevelCall;
    let next: LevelCall;
    if (vi.isMockFunction(current)) {
      const impl = (current as Mock<LevelCall>).getMockImplementation();
      if (!impl) {
        throw new Error(
          `logger.${level} is already a spy with no implementation of its own, so the recorder ` +
            'cannot call on past it. Record lines before that spy is made, or give it an ' +
            'implementation that calls the method it replaced.',
        );
      }
      next = impl;
    } else {
      next = current.bind(logger);
    }
    const wrapper: LevelCall = (...args) => {
      kept.push(JSON.stringify(args, (_k, v) => (v instanceof Error ? v.message : v)));
      return next.apply(logger, args);
    };
    vi.spyOn(logger, level).mockImplementation(wrapper as never);
    wrappers.set(level, wrapper);
  }
  return {
    get lines() {
      for (const [level, wrapper] of wrappers) {
        const now = logger[level] as unknown;
        const live = vi.isMockFunction(now) && (now as Mock).getMockImplementation() === wrapper;
        if (!live) {
          throw new Error(
            `logger.${level} is no longer recorded: it was restored, spied over or replaced by a ` +
              '`logger.level` change after recordLogLines() ran, so a line logged since is missing. ' +
              'Record after the change, or keep the change out of the recorded window.',
          );
        }
      }
      return kept;
    },
    clear() {
      kept.length = 0;
    },
  };
}
