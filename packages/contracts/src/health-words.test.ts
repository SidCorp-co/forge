import { describe, expect, it } from 'vitest';
import { healthLine, healthWords, NOT_CHECKED } from './health-words.js';

describe('a health check in words (ISS-1421 r4 repair 1)', () => {
  it.each(['ok', 'degraded', 'error', 'needs_reauth', 'needs_scope', 'pending', 'unknown', 'new'])(
    'says %s as a capitalised sentence with no field word',
    (status) => {
      expect(healthWords(status)).toMatch(/^[A-Z][^_]*\.$/);
    },
  );

  it('says when it was checked, and that it never was', () => {
    expect(healthLine('ok', '3 hours ago')).toBe('The last check passed. Checked 3 hours ago.');
    expect(healthLine('ok')).toBe('The last check passed.');
    expect(healthLine(null, '3 hours ago')).toBe(NOT_CHECKED);
  });
});
