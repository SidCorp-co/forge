import { createHmac } from 'node:crypto';
import { FEEDBACK_PHASES } from '@forge/contracts/feedback';
import { WIDGET_LIMIT_DEFAULTS, WIDGET_SIGNATURE_MAX_AGE_S } from '@forge/contracts/widget';
import { describe, expect, it } from 'vitest';
import { RefusalError } from '../lib/refusal.js';
import {
  embeddedRefusal,
  identityOf,
  limitsOf,
  originRefusal,
  signatureRefusal,
  visitorStatusOf,
} from './rules.js';

const SECRET = 'whsec_unit_test_secret';
const NOW = 1_800_000_000_000;
const ts = Math.floor(NOW / 1000);
const sign = (userId: string, at: number, secret = SECRET) =>
  createHmac('sha256', secret).update(`${userId}.${at}`).digest('hex');

const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (err) {
    if (!(err instanceof RefusalError)) throw err;
    return err.refusals[0]?.code ?? null;
  }
};

describe('limitsOf', () => {
  it('takes each cap the binding sets and the contract default for the rest', () => {
    expect(limitsOf({})).toEqual(WIDGET_LIMIT_DEFAULTS);
    expect(limitsOf({ limits: { messageMaxChars: 300 } })).toEqual({
      ...WIDGET_LIMIT_DEFAULTS,
      messageMaxChars: 300,
    });
  });
});

describe('originRefusal', () => {
  const allowed = { site: ['https://shop.example'], frame: ['https://forge.example'] };

  it('admits the site and the frame, case aside', () => {
    expect(originRefusal('https://shop.example', allowed, true)).toBeNull();
    expect(originRefusal('HTTPS://SHOP.EXAMPLE', allowed, true)).toBeNull();
    expect(originRefusal('https://forge.example', allowed, true)).toBeNull();
  });

  it('refuses another origin, a look-alike and a port, by name', () => {
    for (const origin of [
      'https://evil.example',
      'https://shop.example.evil.example',
      'http://shop.example',
      'https://shop.example:8443',
      'null',
    ]) {
      const refused = originRefusal(origin, allowed, false);
      expect(refused?.refusals[0]?.code, origin).toBe('WIDGET_ORIGIN_REFUSED');
    }
  });

  it('refuses a missing Origin only where the request changes something', () => {
    expect(originRefusal(undefined, allowed, false)).toBeNull();
    expect(originRefusal(undefined, allowed, true)?.refusals[0]?.code).toBe(
      'WIDGET_ORIGIN_REFUSED',
    );
    expect(originRefusal('', allowed, true)?.refusals[0]?.code).toBe('WIDGET_ORIGIN_REFUSED');
  });
});

describe('embeddedRefusal', () => {
  const allowed = ['https://shop.example'];

  it('takes no claim, or an allowed origin, case aside', () => {
    expect(embeddedRefusal(undefined, allowed)).toBeNull();
    expect(embeddedRefusal('https://shop.example', allowed)).toBeNull();
    expect(embeddedRefusal('HTTPS://SHOP.EXAMPLE', allowed)).toBeNull();
  });

  it('refuses a framing origin the site does not allow, the frame’s own origin included', () => {
    for (const origin of ['https://evil.example', 'https://forge.example', 'http://shop.example']) {
      expect(embeddedRefusal(origin, allowed)?.refusals[0]).toMatchObject({
        code: 'WIDGET_ORIGIN_REFUSED',
        path: '/embeddedAt',
      });
    }
  });
});

describe('signatureRefusal', () => {
  it('admits the HMAC of userId.ts under the secret', () => {
    expect(signatureRefusal(SECRET, { userId: 'u1', ts, sig: sign('u1', ts) }, NOW)).toBeNull();
  });

  it('refuses another user’s, another secret’s, an altered ts and no secret at all', () => {
    const cases = [
      { secret: SECRET, signed: { userId: 'u2', ts, sig: sign('u1', ts) } },
      { secret: SECRET, signed: { userId: 'u1', ts, sig: sign('u1', ts, 'whsec_other') } },
      { secret: SECRET, signed: { userId: 'u1', ts: ts - 1, sig: sign('u1', ts) } },
      { secret: null, signed: { userId: 'u1', ts, sig: sign('u1', ts) } },
    ];
    for (const { secret, signed } of cases) {
      expect(signatureRefusal(secret, signed, NOW)?.refusals[0]?.code).toBe(
        'WIDGET_SIGNATURE_INVALID',
      );
    }
  });

  it('holds a signature good for its max age either side of now, and not a second more', () => {
    for (const at of [ts - WIDGET_SIGNATURE_MAX_AGE_S, ts + WIDGET_SIGNATURE_MAX_AGE_S]) {
      expect(
        signatureRefusal(SECRET, { userId: 'u1', ts: at, sig: sign('u1', at) }, NOW),
      ).toBeNull();
    }
    for (const at of [ts - WIDGET_SIGNATURE_MAX_AGE_S - 1, ts + WIDGET_SIGNATURE_MAX_AGE_S + 1]) {
      const refused = signatureRefusal(SECRET, { userId: 'u1', ts: at, sig: sign('u1', at) }, NOW);
      expect(refused?.refusals[0]).toMatchObject({
        code: 'WIDGET_SIGNATURE_INVALID',
        path: '/signed/ts',
      });
    }
  });
});

describe('identityOf', () => {
  it('anonymous: takes a visitor as given, an email optional', () => {
    expect(identityOf('anonymous', {}, null, NOW)).toEqual({
      mode: 'anonymous',
      email: null,
      name: null,
      signedUserId: null,
    });
    expect(identityOf('anonymous', { visitor: { email: 'a@b.example' } }, null, NOW).email).toBe(
      'a@b.example',
    );
  });

  it('email: refuses a visitor with no email', () => {
    expect(codeOf(() => identityOf('email', { visitor: { name: 'Ana' } }, null, NOW))).toBe(
      'WIDGET_IDENTITY_REQUIRED',
    );
    expect(identityOf('email', { visitor: { email: 'a@b.example' } }, null, NOW).email).toBe(
      'a@b.example',
    );
  });

  it('refuses a signed identity where the site does not sign, and a bare visitor where it does', () => {
    const signed = { userId: 'u1', ts, sig: sign('u1', ts) };
    expect(codeOf(() => identityOf('anonymous', { signed }, SECRET, NOW))).toBe('WIDGET_REFUSED');
    expect(codeOf(() => identityOf('email', { signed }, SECRET, NOW))).toBe('WIDGET_REFUSED');
    expect(
      codeOf(() =>
        identityOf('signed', { signed, visitor: { email: 'a@b.example' } }, SECRET, NOW),
      ),
    ).toBe('WIDGET_REFUSED');
    expect(codeOf(() => identityOf('signed', {}, SECRET, NOW))).toBe('WIDGET_IDENTITY_REQUIRED');
  });

  it('signed: takes the signed user, and the email the site vouched for', () => {
    const identity = identityOf(
      'signed',
      { signed: { userId: 'u1', ts, sig: sign('u1', ts), email: 'u1@b.example' } },
      SECRET,
      NOW,
    );
    expect(identity).toEqual({
      mode: 'signed',
      email: 'u1@b.example',
      name: null,
      signedUserId: 'u1',
    });
  });
});

describe('visitorStatusOf', () => {
  it('says a sentence for every phase, never naming an issue, a requirement or a person', () => {
    for (const phase of FEEDBACK_PHASES) {
      for (const route of [null, 'issue', 'revision', 'new_requirement'] as const) {
        const said = visitorStatusOf({ phase, route, redacted: false });
        expect(said.says).toMatch(/^[A-Z].*\.$/s);
        expect(said.says).not.toMatch(/ISS-|REQ-|FB-|@/);
      }
    }
  });

  it('maps the lifecycle onto five phases', () => {
    const at = (
      phase: (typeof FEEDBACK_PHASES)[number],
      route: 'issue' | 'answer' | 'duplicate' | null = null,
    ) => visitorStatusOf({ phase, route, redacted: false }).phase;
    expect(at('new')).toBe('received');
    expect(at('triaged', 'issue')).toBe('triaged');
    expect(at('planned', 'issue')).toBe('in_progress');
    expect(at('resolved', 'issue')).toBe('shipped');
    expect(at('verified', 'issue')).toBe('shipped');
    expect(at('declined')).toBe('closed');
    expect(at('triaged', 'answer')).toBe('closed');
    expect(at('triaged', 'duplicate')).toBe('closed');
    expect(visitorStatusOf({ phase: 'planned', route: 'issue', redacted: true })).toEqual({
      phase: 'closed',
      says: 'The details of this report were deleted.',
    });
  });
});
