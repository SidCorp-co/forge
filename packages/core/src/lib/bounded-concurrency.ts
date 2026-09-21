export interface Limiter {
  /** Run `task` once a slot is free; the slot is released even if it throws. */
  run<T>(task: () => Promise<T>): Promise<T>;
  /** Tasks currently holding a slot. Read by tests and by nothing else. */
  readonly inFlight: number;
  /** Callers parked waiting for a slot. Read by tests and by nothing else. */
  readonly waiting: number;
}

export function createLimiter(limit: number): Limiter {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`bounded-concurrency: limit must be a positive integer, got ${limit}`);
  }

  let active = 0;
  const parked: Array<() => void> = [];

  const release = (): void => {
    const next = parked.shift();
    if (next) next();
    else active -= 1;
  };

  return {
    get inFlight() {
      return active;
    },
    get waiting() {
      return parked.length;
    },
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (active >= limit) await new Promise<void>((resolve) => parked.push(resolve));
      else active += 1;
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}
