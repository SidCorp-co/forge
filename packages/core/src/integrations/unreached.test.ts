import { describe, expect, it } from 'vitest';
import { thrownDiagnostics, unreachedBy, unreachedWords } from './unreached.js';

/** What undici throws for a request that never reached its host: `fetch failed`, the reason in its cause. */
function fetchFailed(cause: unknown): TypeError {
  return new TypeError('fetch failed', { cause });
}

describe('unreachedBy', () => {
  it('reads a host that does not resolve off the cause undici names', () => {
    const err = fetchFailed(
      Object.assign(new Error('getaddrinfo ENOTFOUND x.invalid'), { code: 'ENOTFOUND' }),
    );
    expect(unreachedBy(err)).toEqual({ reason: 'host_unresolved', code: 'ENOTFOUND' });
  });

  it('reads a refused connection inside the AggregateError node raises for several addresses', () => {
    const inner = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const err = fetchFailed(new AggregateError([inner], 'connect failed'));
    expect(unreachedBy(err)).toEqual({ reason: 'refused', code: 'ECONNREFUSED' });
  });

  it('reads an aborted request as one no answer came to in time', () => {
    const err = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    expect(unreachedBy(err)?.reason).toBe('timed_out');
  });

  it('reads a certificate refusal and a cut connection by their codes', () => {
    expect(unreachedBy(fetchFailed({ code: 'CERT_HAS_EXPIRED' }))?.reason).toBe('certificate');
    expect(unreachedBy(fetchFailed({ code: 'ECONNRESET' }))?.reason).toBe('reset');
  });

  it('still says the host was not reached where undici names no cause', () => {
    expect(unreachedBy(fetchFailed(undefined))).toEqual({ reason: 'unreachable', code: null });
  });

  it('is null for an error that is not a transport failure', () => {
    expect(unreachedBy(new SyntaxError('Unexpected token <'))).toBeNull();
    expect(unreachedBy('fetch failed')).toBeNull();
  });
});

describe('thrownDiagnostics', () => {
  it('names the reason and its code for a host not reached, and only `thrown` otherwise', () => {
    expect(thrownDiagnostics(fetchFailed({ code: 'ENOTFOUND' }))).toEqual({
      unreached: 'host_unresolved',
      unreachedCode: 'ENOTFOUND',
    });
    expect(thrownDiagnostics(new Error('boom'))).toEqual({ thrown: true });
  });
});

describe('unreachedWords', () => {
  it('is capitalised sentences ending with a full stop, each at most 25 words', () => {
    for (const reason of [
      'host_unresolved',
      'refused',
      'timed_out',
      'certificate',
      'reset',
      'unreachable',
    ] as const) {
      const words = unreachedWords('Coolify', reason);
      for (const sentence of words.split(/(?<=\.) /)) {
        expect(sentence, reason).toMatch(/^[A-Z].*\.$/);
        expect(sentence.split(/\s+/).length, reason).toBeLessThanOrEqual(25);
      }
      expect(words).toMatch(/^Forge could not reach Coolify, because /);
    }
  });
});
