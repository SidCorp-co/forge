import { describe, expect, it } from 'vitest';
import { isQuotaRejection } from './client.js';

describe('isQuotaRejection', () => {
  it('classifies the real budget-exceeded 400 that lost a learning', () => {
    expect(
      isQuotaRejection(
        400,
        '{"error":{"message":"Budget has been exceeded! Current cost: 10.000262189999628, Max budget: 10.0"}}',
      ),
    ).toBe(true);
  });

  it.each([429, 402, 403])('classifies %i with a quota body', (status) => {
    expect(isQuotaRejection(status, 'insufficient_quota')).toBe(true);
  });

  it('classifies any 429 even with an empty body', () => {
    expect(isQuotaRejection(429, '')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isQuotaRejection(400, 'BUDGET HAS BEEN EXCEEDED')).toBe(true);
  });

  it('does not classify an unrelated 400', () => {
    expect(isQuotaRejection(400, 'invalid model name')).toBe(false);
    expect(isQuotaRejection(404, 'not found')).toBe(false);
    expect(isQuotaRejection(400, '')).toBe(false);
  });
});
