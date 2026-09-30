import { z } from 'zod';

export function utf16String(maxUnits: number) {
  return z.string().refine((s) => s.length <= maxUnits, {
    error: `must be at most ${maxUnits} UTF-16 code units`,
  });
}
