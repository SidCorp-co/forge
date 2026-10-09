import { describe, expect, it } from 'vitest';
import { type Env, previewDomainIssue, siteOf } from './env.js';

const env = (over: Partial<Env>) =>
  ({ APP_BASE_URL: 'https://forge-dev.sidcorp.co', NODE_ENV: 'production', ...over }) as Env;

describe('previewDomainIssue: previews are served from another site than Forge (REQ-39 BC-4)', () => {
  it('serves nothing and refuses nothing while PREVIEW_DOMAIN is unset', () => {
    expect(previewDomainIssue(env({}))).toBeNull();
  });

  it('refuses a preview domain on the web origin site, or under the session cookie domain', () => {
    expect(previewDomainIssue(env({ PREVIEW_DOMAIN: 'preview.sidcorp.co' }))).toContain(
      'same site (sidcorp.co)',
    );
    expect(
      previewDomainIssue(
        env({
          APP_BASE_URL: 'https://forge.example.dev',
          AUTH_COOKIE_DOMAIN: '.preview.example.net',
          PREVIEW_DOMAIN: 'a.preview.example.net',
        }),
      ),
    ).toContain('under AUTH_COOKIE_DOMAIN');
  });

  it('takes another site, and a development host:port only outside production', () => {
    expect(previewDomainIssue(env({ PREVIEW_DOMAIN: 'sidcorp-preview.dev' }))).toBeNull();
    expect(previewDomainIssue(env({ PREVIEW_DOMAIN: 'preview.localhost:8080' }))).toContain(
      'names a port',
    );
    expect(
      previewDomainIssue(
        env({
          APP_BASE_URL: 'http://localhost:3000',
          NODE_ENV: 'development',
          PREVIEW_DOMAIN: 'preview.localhost:8080',
        }),
      ),
    ).toBeNull();
  });

  it('judges a site by its last two labels, and an address by itself', () => {
    expect(siteOf('p-x.preview.sidcorp.co:443')).toBe('sidcorp.co');
    expect(siteOf('127.0.0.1')).toBe('127.0.0.1');
  });
});
