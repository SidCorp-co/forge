import { describe, expect, it } from 'vitest';
import {
  MIN_PASSWORD_SCORE,
  evaluatePasswordStrength,
} from './password-strength.js';

describe('password-strength', () => {
  it('rejects an obvious dictionary password', () => {
    const r = evaluatePasswordStrength('password');
    expect(r.score).toBeLessThan(MIN_PASSWORD_SCORE);
  });

  it('rejects a password that contains the user’s email local-part', () => {
    const r = evaluatePasswordStrength('alex123!', ['alex@studio.com']);
    expect(r.score).toBeLessThan(MIN_PASSWORD_SCORE);
  });

  it('accepts a strong, high-entropy passphrase', () => {
    // Three uncommon words + symbol — solidly in score 3+ territory.
    const r = evaluatePasswordStrength('quartz-juniper-tessellate$77');
    expect(r.score).toBeGreaterThanOrEqual(MIN_PASSWORD_SCORE);
  });

  it('returns suggestions for weak inputs', () => {
    const r = evaluatePasswordStrength('123456');
    expect(r.suggestions.length).toBeGreaterThan(0);
  });
});
