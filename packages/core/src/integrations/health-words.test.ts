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
      'Postman refused the stored credential, so it needs signing in again. Invalid Postman API key.',
    );
    expect(answered.diagnostics).toEqual({ httpStatus: 401, checkSaid: 'invalid Postman API key' });
    expect(answered.status).toBe('needs_reauth');
  });

  it('says a failed check could not be made, by the provider label', () => {
    expect(
      healthAnswer('postman', { status: 'error', message: 'No Postman API key is saved.' }).message,
    ).toBe('Forge could not check Postman. No Postman API key is saved.');
  });

  // ISS-1421 r15 — judge-65: a Coolify host that does not resolve answered "Forge could not check
  // Coolify. It said: Fetch failed.", the HTTP client's text in the mouth of a provider never reached.
  it("says why a host was not reached in Forge's words, the client's text kept in diagnostics", () => {
    const answered = healthAnswer('postman', {
      status: 'error',
      message: 'fetch failed',
      diagnostics: { httpStatus: null, unreached: 'host_unresolved', unreachedCode: 'ENOTFOUND' },
    });
    expect(answered.message).toBe(
      'Forge could not reach Postman, because its host name does not resolve. Check the address saved on this connection, then test again.',
    );
    expect(answered.message).not.toMatch(/It said|fetch failed/i);
    expect(answered.diagnostics).toMatchObject({
      checkSaid: 'fetch failed',
      unreachedCode: 'ENOTFOUND',
    });
  });

  it("never quotes a thrown error as Forge's sentence or as the provider's", () => {
    const answered = healthAnswer('postman', {
      status: 'error',
      message: 'Unexpected token < in JSON at position 0',
      diagnostics: { thrown: true },
    });
    // An answer that could not be read is still an answer, so nothing says Postman never answered.
    expect(answered.message).toBe(
      'Forge could not check Postman. The check failed, and what failed is kept in the diagnostics.',
    );
    expect(answered.message).not.toMatch(/before Postman answered/);
    expect(answered.diagnostics?.checkSaid).toBe('Unexpected token < in JSON at position 0');
  });

  it('never says "It said" for any answer', () => {
    for (const status of ['degraded', 'error', 'needs_reauth', 'needs_scope'] as const) {
      expect(healthAnswer('postman', { status, message: 'x' }).message).not.toMatch(/It said/);
    }
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
