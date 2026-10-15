/**
 * GitHub sends the browser back to the origin the connect request reached core at, so the return
 * carries the person's session: the web's origin where the web serves `/api` in front of core (how
 * forge-dev is served), the API's own where the request went there. Deliveries from GitHub's servers
 * still go to the API's public origin. An origin this core is not configured to answer on is refused
 * by name, never written into a manifest.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// env is read once, on first use: the two public origins are set before anything imports it
vi.hoisted(() => {
  process.env.PUBLIC_API_BASE_URL = 'https://api.forge.test';
  process.env.APP_BASE_URL = 'https://web.forge.test';
  // with no App yet, only an operator is handed the manifest
  process.env.ADMIN_EMAILS = 'operator@callback-origin.test';
});

import { api, userToken } from '../helpers/api.js';
import { testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';

let session = '';
let project = { id: '', slug: '' };

beforeAll(() => {
  testEnv();
});

beforeEach(async () => {
  await truncateAll();
  const owner = (await createTestUser({ verified: true, email: 'operator@callback-origin.test' }))
    .id;
  project = await createTestProject(owner);
  await addProjectMember(project.id, owner, 'owner');
  session = await userToken(owner);
});

const connectAt = (host: string) =>
  api(session, 'POST', `/api/projects/${project.id}/integrations/github/connect`, undefined, {
    'x-forwarded-host': host,
    'x-forwarded-proto': 'https',
  });

type Manifest = {
  redirect_url: string;
  setup_url: string;
  callback_urls: string[];
  hook_attributes: { url: string };
};

describe('the GitHub manifest names the origin the connect request came from', () => {
  it('sends the browser back to the web origin when the web serves /api, and deliveries to the API', async () => {
    const res = await connectAt('web.forge.test');

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const manifest = res.body.manifest as Manifest;
    expect(manifest.redirect_url).toBe(
      'https://web.forge.test/api/integrations/github/manifest-callback',
    );
    expect(manifest.setup_url).toBe('https://web.forge.test/api/integrations/github/installed');
    expect(manifest.callback_urls).toEqual([
      'https://web.forge.test/api/integrations/github/installed',
    ]);
    expect(manifest.hook_attributes.url).toBe('https://api.forge.test/api/webhooks/github/app');
  });

  it('sends the browser back to the API origin when the request went there', async () => {
    const res = await connectAt('api.forge.test');

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const manifest = res.body.manifest as Manifest;
    expect(manifest.redirect_url).toBe(
      'https://api.forge.test/api/integrations/github/manifest-callback',
    );
    expect(manifest.setup_url).toBe('https://api.forge.test/api/integrations/github/installed');
  });

  it('refuses an origin this core is not configured to answer on, naming it, and hands out no manifest', async () => {
    const res = await connectAt('evil.example');

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).toContain('https://evil.example');
    expect(JSON.stringify(res.body)).toContain('https://web.forge.test');
    expect(res.body.manifest).toBeUndefined();
  });
});
