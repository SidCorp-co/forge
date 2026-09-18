import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  buildAppManifest,
  convertManifestCode,
  manifestPostUrl,
  signConnectState,
  verifyConnectState,
} from './connect.js';

const SECRET = 'state-signing-secret-at-least-32-chars';
const NOW = 1_800_000_000_000;
const STATE = { projectId: 'p-1', userId: 'u-1' };

describe('connect state', () => {
  it('round-trips a state it signed', () => {
    const token = signConnectState(SECRET, STATE, NOW);
    expect(verifyConnectState(SECRET, token, NOW + 1000)).toEqual(STATE);
  });

  it('rejects a tampered payload, a foreign signature, and an expired state', () => {
    const token = signConnectState(SECRET, STATE, NOW);
    const [body, mac] = token.split('.');

    const swapped = Buffer.from(
      JSON.stringify({ ...STATE, projectId: 'p-attacker', exp: NOW + 600_000 }),
    ).toString('base64url');
    expect(verifyConnectState(SECRET, `${swapped}.${mac}`, NOW)).toBeNull();

    expect(verifyConnectState('a-different-secret-of-the-same-length!!', token, NOW)).toBeNull();
    expect(verifyConnectState(SECRET, token, NOW + 11 * 60_000)).toBeNull();
    expect(verifyConnectState(SECRET, body as string, NOW)).toBeNull();
  });
});

describe('buildAppManifest', () => {
  const split = () =>
    buildAppManifest({
      appName: 'Forge — demo',
      webBaseUrl: 'https://forge.example/',
      apiBaseUrl: 'https://api.forge.example/',
      projectSlug: 'demo',
    });

  it('points the webhook at this core and the redirect at the conversion route', () => {
    const m = split();
    expect((m.hook_attributes as { url: string }).url).toBe(
      'https://api.forge.example/api/webhooks/in/demo',
    );
    expect(m.redirect_url).toBe(
      'https://api.forge.example/api/integrations/github/manifest-callback',
    );
    expect(m.public).toBe(false);
    expect((m.default_permissions as Record<string, string>).pull_requests).toBe('write');
  });

  it('sends every core-served URL to the api origin and only the homepage to the web', () => {
    const m = split();
    expect(m.url).toBe('https://forge.example');
    for (const u of [m.redirect_url, m.setup_url, (m.hook_attributes as { url: string }).url]) {
      expect(u).toMatch(/^https:\/\/api\.forge\.example\//);
    }
  });

  // cm:guard ISS-1072 — the App cannot publish `forge/issue-contract` on `checks: read`, and a manifest decides the permissions of Apps created AFTER it alone. This holds the request; the case below holds the sentence that tells an operator what to do about the App that exists.
  it('requests `checks: write`, which is what publishing a check run needs', () => {
    expect((split().default_permissions as Record<string, string>).checks).toBe('write');
  });

  it('states what an operator does to the App that already exists', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'connect.ts'),
      'utf8',
    );
    const manifest = source.slice(0, source.indexOf('default_permissions'));
    // A manifest change reaches no existing installation, so the migration path has to be
    // written down where the change is — or the one App Forge has keeps failing 403 with the
    // fix known to nobody.
    expect(manifest).toContain('Read and write');
    expect(manifest).toContain('approve');
    expect(manifest).toMatch(/Reconnecting does NOT|reconnecting will not/i);
  });

  it('posts to the org endpoint when an org is named', () => {
    expect(manifestPostUrl('sidcorp')).toBe(
      'https://github.com/organizations/sidcorp/settings/apps/new',
    );
    expect(manifestPostUrl(null)).toBe('https://github.com/settings/apps/new');
  });
});

describe('convertManifestCode', () => {
  const ok = {
    id: 987,
    pem: '-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----',
    webhook_secret: 'whs_from_github',
    slug: 'forge-demo',
    html_url: 'https://github.com/apps/forge-demo',
  };

  it('returns the three credentials GitHub generated', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(ok), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    const app = await convertManifestCode({ code: 'abc123', fetchImpl });
    expect(app).toMatchObject({
      appId: '987',
      webhookSecret: 'whs_from_github',
      slug: 'forge-demo',
    });
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/app-manifests/abc123/conversions');
    expect(init.method).toBe('POST');
  });

  it('refuses a conversion missing any one of the three', async () => {
    for (const drop of ['id', 'pem', 'webhook_secret'] as const) {
      const partial: Record<string, unknown> = { ...ok };
      delete partial[drop];
      const fetchImpl = vi.fn(
        async () =>
          new Response(JSON.stringify(partial), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ) as unknown as typeof fetch;
      await expect(convertManifestCode({ code: 'c', fetchImpl })).rejects.toThrow(/incomplete/);
    }
  });
});
