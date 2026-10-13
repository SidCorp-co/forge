import { describe, expect, it } from 'vitest';
import { loginHref, readReturnPath } from './return-path';

const refused = (raw: Parameters<typeof readReturnPath>[0]) => {
  const read = readReturnPath(raw);
  if (read.kind !== 'refused') throw new Error(`${JSON.stringify(raw)} read as ${read.kind}`);
  return read.why;
};

describe('the return address a login is given', () => {
  it('follows a same-origin path with its query string and fragment intact', () => {
    expect(readReturnPath('/docs?path=connect-an-assistant/claude-code')).toEqual({
      kind: 'path',
      path: '/docs?path=connect-an-assistant/claude-code',
    });
    expect(readReturnPath('/projects/forge-dev/issues?status=open&q=a%20b#top')).toEqual({
      kind: 'path',
      path: '/projects/forge-dev/issues?status=open&q=a%20b#top',
    });
  });

  it('reads no address at all as none, so the dashboard stays the default', () => {
    for (const raw of [undefined, null, '']) expect(readReturnPath(raw)).toEqual({ kind: 'none' });
  });

  it('refuses every way of naming another site, by its reason', () => {
    expect(refused('https://evil.example/x')).toMatch(/starts with "\/"/);
    expect(refused('evil.example/x')).toMatch(/starts with "\/"/);
    expect(refused('javascript:alert(1)')).toMatch(/starts with "\/"/);
    expect(refused('//evil.example/x')).toMatch(/another site/);
    expect(refused('/\\evil.example')).toMatch(/backslash/);
    expect(refused('/\t/evil.example')).toMatch(/control character/);
    expect(refused('/\n/evil.example')).toMatch(/control character/);
  });

  it('refuses an address that only resolves to another site once dot segments are applied', () => {
    expect(refused('/.//evil.example')).toMatch(/resolves to another site/);
    expect(refused('/a/..//evil.example')).toMatch(/resolves to another site/);
  });

  it('refuses a repeated parameter and an over-long address', () => {
    expect(refused(['/a', '/b'])).toMatch(/2 times/);
    expect(refused(`/${'a'.repeat(2048)}`)).toMatch(/longer than 2048/);
  });
});

describe('the login URL of a signed-out visit', () => {
  it('carries the address that was opened, encoded, query string included', () => {
    expect(loginHref('/docs?path=connect-an-assistant/claude-code')).toBe(
      '/login?next=%2Fdocs%3Fpath%3Dconnect-an-assistant%2Fclaude-code',
    );
  });

  it('carries nothing for the dashboard, which is where a login lands anyway', () => {
    expect(loginHref('/')).toBe('/login');
  });

  it('carries nothing for an address it would itself refuse', () => {
    expect(loginHref('//evil.example')).toBe('/login');
  });
});
