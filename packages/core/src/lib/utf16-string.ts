import { z } from 'zod';

/**
 * A string bounded in UTF-16 code units, the unit `String.length` and a Rust
 * producer's `encode_utf16()` count. zod's `max()` counts Unicode code points,
 * so a bound agreed with the runner in units states that unit here instead of
 * taking zod's (ISS-1354).
 */
export function utf16String(maxUnits: number) {
  return z.string().refine((s) => s.length <= maxUnits, {
    error: `must be at most ${maxUnits} UTF-16 code units`,
  });
}
