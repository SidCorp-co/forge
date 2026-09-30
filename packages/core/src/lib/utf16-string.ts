import { z } from 'zod';

/** Bounded in UTF-16 code units, as the runner clips; zod's `max()` counts code points. */
export function utf16String(maxUnits: number) {
  return z.string().refine((s) => s.length <= maxUnits, {
    error: `must be at most ${maxUnits} UTF-16 code units`,
  });
}
