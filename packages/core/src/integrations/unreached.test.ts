import { describe, expect, it } from 'vitest';
import { CoolifyApiError, describeCoolifyAnswer } from './coolify/client.js';
import {
  addressForReader,
  CHECK_ADDRESS,
  thrownDiagnostics,
  unreachedBy,
  unreachedHostOf,
  unreachedWords,
} from './unreached.js';

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

  // ISS-1421 r33: the host a check was sent to rides with the reason, so the answer can name it.
  it('carries the host it was sent to where the caller names one, and reads it back', () => {
    const said = thrownDiagnostics(fetchFailed({ code: 'ENOTFOUND' }), {
      host: 'api.github.com',
      saved: false,
    });
    expect(said).toMatchObject({ unreachedHost: 'api.github.com', unreachedHostSaved: false });
    expect(unreachedHostOf(said)).toEqual({ host: 'api.github.com', saved: false });
    expect(unreachedHostOf({ unreached: 'refused' })).toBeUndefined();
    expect(thrownDiagnostics(new Error('boom'), { host: 'x', saved: true })).toEqual({
      thrown: true,
    });
  });
});

describe('unreachedWords naming a host', () => {
  it('names the host, and sends a reader to the saved address only where the connection saves it', () => {
    for (const reason of [
      'host_unresolved',
      'refused',
      'timed_out',
      'certificate',
      'reset',
      'unreachable',
    ] as const) {
      const fixed = unreachedWords('GitHub', reason, { host: 'api.github.com', saved: false });
      expect(fixed).toMatch(/^Forge could not reach GitHub at api\.github\.com, because /);
      expect(fixed).toMatch(/ Test again once api\.github\.com answers\.$/);
      expect(fixed).not.toMatch(/address saved/);
      const own = unreachedWords('GitHub', reason, { host: 'ghe.example.test', saved: true });
      expect(own).toMatch(/^Forge could not reach GitHub at ghe\.example\.test, because /);
      expect(own).toMatch(/address/);
      for (const sentence of [...fixed.split(/(?<=\.) /), ...own.split(/(?<=\.) /)]) {
        expect(sentence.split(/\s+/).length, reason).toBeLessThanOrEqual(25);
      }
    }
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

// ISS-1421 r29: a plain member was told to "Check the address saved on this connection", which
// only the people who save its key may change.
describe('addressForReader', () => {
  const who = 'an owner or admin of the organization that owns it';

  it.each(Object.entries(CHECK_ADDRESS))(
    'says who may change the address in place of %s',
    (_k, own) => {
      const said = addressForReader(`Something failed. ${own}`, who);
      expect(said).not.toContain(own);
      expect(said).toMatch(/[Oo]nly an owner or admin of the organization that owns it can change/);
      expect(said).toContain('ask one of them');
    },
  );

  it('rewrites the sentence every failure says it in', () => {
    for (const reason of ['host_unresolved', 'timed_out'] as const) {
      const said = addressForReader(unreachedWords('Coolify', reason), who);
      expect(said, reason).not.toMatch(/^Check|\. Check/);
      expect(said, reason).toContain(`Only ${who} can change the address`);
    }
    const notCoolify = new CoolifyApiError(
      404,
      '<html></html>',
      'The server at example.com answered 404 Not Found.',
      'GET /api/v1/applications',
      true,
    );
    expect(addressForReader(describeCoolifyAnswer(notCoolify), who)).toContain(
      `Only ${who} can change the address saved on this connection, so ask one of them.`,
    );
  });

  it('says who may save a new token where a 401 told the reader to save one', () => {
    const refused = new CoolifyApiError(
      401,
      '{"message":"Unauthenticated."}',
      'The server at example.com answered 401 Unauthorized.',
      'GET /api/v1/applications',
    );
    const said = addressForReader(describeCoolifyAnswer(refused), who);
    expect(said).not.toMatch(/save a new token from|check the address/i);
    expect(said).toContain(
      `it refused the stored API token, and only ${who} can save a new one to this connection, so ask one of them.`,
    );
    expect(said).toContain(
      `If it is not, only ${who} can change the address saved on this connection`,
    );
  });

  it('leaves a sentence that names no address as it was', () => {
    expect(addressForReader('Coolify answered 500. Test again once it answers.', who)).toBe(
      'Coolify answered 500. Test again once it answers.',
    );
  });
});
