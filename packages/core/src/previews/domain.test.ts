import { describe, expect, it } from 'vitest';
import { framableCookie, type PreviewSite } from './domain.js';

const site = (host: string, scheme: PreviewSite['scheme'], port: string | null): PreviewSite => ({
  host,
  scheme,
  port,
});

describe('framableCookie', () => {
  it('is true where a frame on another site can be sent the cookie: https, and localhost in development', () => {
    expect(framableCookie(site('previews.example.com', 'https:', null))).toBe(true);
    expect(framableCookie(site('preview.localhost', 'http:', '7311'))).toBe(true);
    expect(framableCookie(site('localhost', 'http:', '7311'))).toBe(true);
  });

  it('is false on any other plain-http domain, and on a host that only ends like localhost', () => {
    expect(framableCookie(site('preview.test', 'http:', '8080'))).toBe(false);
    expect(framableCookie(site('notlocalhost', 'http:', '8080'))).toBe(false);
    expect(framableCookie(site('localhost.example.com', 'http:', '8080'))).toBe(false);
  });
});
