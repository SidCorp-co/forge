import { describe, expect, it } from 'vitest';
import { sessionCookieDomain } from './cookie.js';

describe('sessionCookieDomain: the session cookie names the domain only where the browser takes it', () => {
  it('names the configured domain for a host under it, by the forwarded host first', () => {
    expect(sessionCookieDomain('.sidcorp.co', undefined, 'forge-dev-api.sidcorp.co')).toBe(
      '.sidcorp.co',
    );
    expect(sessionCookieDomain('sidcorp.co', 'forge-dev.sidcorp.co', 'core.internal:8080')).toBe(
      'sidcorp.co',
    );
    expect(sessionCookieDomain('sidcorp.co', undefined, 'sidcorp.co')).toBe('sidcorp.co');
  });

  it("writes host-only for Forge's own web previewed from a run, outside the domain (REQ-39)", () => {
    expect(
      sessionCookieDomain(
        '.sidcorp.co',
        'p-abcdefghijklmnop.preview.example.dev',
        'forge-dev-api.sidcorp.co',
      ),
    ).toBeUndefined();
    expect(sessionCookieDomain('sidcorp.co', undefined, 'evilsidcorp.co')).toBeUndefined();
  });

  it('writes host-only with no domain configured, and names it when no host is known', () => {
    expect(sessionCookieDomain(undefined, undefined, 'forge.example.dev')).toBeUndefined();
    expect(sessionCookieDomain('sidcorp.co', undefined, undefined)).toBe('sidcorp.co');
  });
});
