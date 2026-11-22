// @direct-test-of packages/core/src/support/look-act.ts
// @direct-test-of packages/core/src/project-config/look-sign-in.ts
// @direct-test-of packages/core/src/support/look-session.ts
// ISS-1356: a look reaches only the room's own project's environments. A command a look again runs
// may name an address only on one of them; any other is refused before it runs.

import { describe, expect, it } from 'vitest';
import { cookieOf, leastPrivileged } from '../project-config/look-sign-in.js';
import { stepRefusal } from './look-act.js';
import { sessionSteps } from './look-session.js';

const OURS = new Set(['https://staging.adminhub.example', 'https://admin.adminhub.example']);

describe("a look's step stays on its project's environments", () => {
  it('lets a step naming no address, or one of its own environments, run', () => {
    expect(stepRefusal(['click', '@e12'], OURS)).toBeNull();
    expect(
      stepRefusal(['open', 'https://staging.adminhub.example/suppliers?tab=2'], OURS),
    ).toBeNull();
    expect(stepRefusal(['fill', '@e3', 'PGPrints'], OURS)).toBeNull();
    expect(stepRefusal(['tab', 'new'], OURS)).toBeNull();
  });

  it("refuses an address on another project's environment, another scheme or port, or a bare host", () => {
    for (const address of [
      'https://staging.epod.example/',
      'http://staging.adminhub.example/',
      'https://staging.adminhub.example:8443/',
      'file:///etc/passwd',
      'staging.epod.example/orders',
    ]) {
      expect(stepRefusal(['open', address], OURS), address).toMatch(
        new RegExp(
          `^${address.replace(/[.?/:]/g, '\\$&')} is on none of this project's environments`,
        ),
      );
    }
  });

  it('refuses a step that runs script in the page, which reaches any address', () => {
    expect(stepRefusal(['eval', "location.href='https://x.example'"], OURS)).toMatch(
      /^eval runs script/,
    );
  });

  it('refuses a step that reads back the signed-in session, whose values no feed may show', () => {
    for (const step of [
      ['cookies'],
      ['cookies', 'get'],
      ['storage', 'local'],
      ['state', 'save', 'x.json'],
    ]) {
      expect(stepRefusal(step, OURS), step.join(' ')).toMatch(/reads the signed-in session/);
    }
  });
});

// ISS-1386: a first look signs in as the profile's least privileged actor unless the agent names
// one, and the session it places shows no value in the box's feed.
describe('who a look signs in as, and what its feed shows', () => {
  it('takes the least privileged actor, then the first by name', () => {
    expect(
      leastPrivileged({
        owner: { role: 'org-owner', credential: 'secret://qa/owner' },
        member: { role: 'project-member', credential: 'secret://qa/member' },
        clerk: { role: 'project-member', credential: 'secret://qa/clerk' },
      }),
    ).toBe('clerk');
    expect(leastPrivileged({})).toBeNull();
  });

  it('reads a cookie as the browser holds it, and drops one the sign-in deletes', () => {
    const at = new URL('https://api.shop.test/auth/local');
    expect(
      cookieOf('sid="abc"; Domain=.shop.test; Path=/app; HttpOnly; Secure; SameSite=None', at),
    ).toEqual({
      name: 'sid',
      value: 'abc',
      url: 'https://api.shop.test',
      domain: 'shop.test',
      path: '/app',
      httpOnly: true,
      secure: true,
      sameSite: 'None',
    });
    expect(cookieOf('sid=; Max-Age=0', at)).toBeNull();
    expect(cookieOf('sid=; Expires=Thu, 01 Jan 1970 00:00:00 GMT', at)).toBeNull();
    // Max-Age outranks Expires, so a past Expires beside a live Max-Age keeps the cookie
    expect(cookieOf('sid=abc; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=60', at)?.value).toBe(
      'abc',
    );
    expect(cookieOf('=nameless', at)).toBeNull();
  });

  it('runs the session values on the box, and shows none of them', () => {
    const steps = sessionSteps(
      {
        cookies: [cookieOf('sid=SECRET-SID; Path=/', new URL('https://shop.test/login')) as never],
        storage: { origin: 'https://shop.test', items: [['auth_token', 'SECRET-TOKEN']] },
      },
      'https://shop.test/orders',
    );
    expect(steps.map((s) => s.run[0])).toEqual(['cookies', 'open', 'storage', 'open']);
    expect(JSON.stringify(steps.map((s) => s.run))).toContain('SECRET-TOKEN');
    expect(JSON.stringify(steps.map((s) => s.shown))).not.toMatch(/SECRET-/);
    expect(steps.at(-1)?.run).toEqual(['open', 'https://shop.test/orders']);
  });
});
