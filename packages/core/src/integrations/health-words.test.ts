import { describe, expect, it, vi } from 'vitest';

vi.mock('./registry.js', () => ({
  getIntegration: (provider: string) =>
    provider === 'postman' ? { presentation: { label: 'Postman' } } : undefined,
}));

const { healthAnswer } = await import('./health-words.js');

// ISS-1421 r14 — judge-61 read Postman's and Epodsystem's Test answer as the adapter's own words,
// "invalid Postman API key": lower case, no full stop, and nothing saying whose words they were.
describe('healthAnswer', () => {
  it('words a refused key in a sentence Forge owns, the adapter text kept in diagnostics', () => {
    const answered = healthAnswer('postman', {
      status: 'needs_reauth',
      message: 'invalid Postman API key',
      diagnostics: { httpStatus: 401 },
    });
    expect(answered.message).toBe(
      'Postman refused the stored credential, so it needs signing in again. It said: Invalid Postman API key.',
    );
    expect(answered.diagnostics).toEqual({ httpStatus: 401, checkSaid: 'invalid Postman API key' });
    expect(answered.status).toBe('needs_reauth');
  });

  it('says a failed check could not be made, by the provider label', () => {
    expect(healthAnswer('postman', { status: 'error', message: 'fetch failed' }).message).toBe(
      'Forge could not check Postman. It said: Fetch failed.',
    );
  });

  it('opens every answer with a capital and ends it with a full stop, for every status', () => {
    for (const status of ['ok', 'degraded', 'error', 'needs_reauth', 'needs_scope'] as const) {
      for (const message of [undefined, '', 'lower case and bare']) {
        const said =
          healthAnswer('epodsystem', { status, ...(message === undefined ? {} : { message }) })
            .message ?? '';
        expect(said, `${status} / ${message}`).toMatch(/^[A-Z].*\.$/);
      }
    }
  });

  it('leaves a passing answer in its own words, made a sentence', () => {
    expect(healthAnswer('postman', { status: 'ok', message: 'Authenticated as ann' }).message).toBe(
      'Authenticated as ann.',
    );
  });
});
