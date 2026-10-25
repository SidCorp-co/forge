/**
 * REQ-73 BC-5 transition: a core that resolves no public API origin (PUBLIC_API_BASE_URL,
 * OAUTH_REDIRECT_BASE, APP_BASE_URL) can serve no relay, so it never advertises one. A box keeps the
 * host as its origin and migrates nothing; a runner older than the relay is still served under
 * `PRE_RELAY_RUNNER_AMNESTY`, and a relay-capable one is refused GIT_RELAY_UNAVAILABLE by name,
 * naming the setting that is missing — never handed the token.
 */

import { sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { registerAllIntegrations } from '../../src/integration-registry.js';
import { api } from '../helpers/api.js';
import { HOST, REPO, type RelayWorld, seedRelayWorld, TOKEN } from '../helpers/git-relay-world.js';

vi.hoisted(() => {
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
  // no public origin resolves: none of the three settings the relay URL is built from is set
  delete process.env.PUBLIC_API_BASE_URL;
  delete process.env.OAUTH_REDIRECT_BASE;
  delete process.env.APP_BASE_URL;
});

let world: RelayWorld;

beforeAll(() => {
  registerAllIntegrations();
});

beforeEach(async () => {
  world = await seedRelayWorld();
});

const ask = (host: string, path: string) =>
  api(world.boxToken, 'POST', '/api/devices/me/git-credential', { host, path, protocol: 'https' });

describe('REQ-73 BC-5: with no public origin, core advertises no relay', () => {
  it('a box is provisioned and assigned with the host as its origin, and no relay remote to move to', async () => {
    const provisions = await api(world.boxToken, 'GET', '/api/devices/me/provisions');
    expect(provisions.status, JSON.stringify(provisions.body)).toBe(200);
    const [row] = provisions.body as unknown as Array<{ repoUrl: string }>;
    expect(row?.repoUrl).toBe(`https://${HOST}/${REPO}.git`);

    const runners = await api(world.boxToken, 'GET', '/api/devices/me/runners');
    const [assignment] = runners.body as unknown as Array<{ relayRemote: string | null }>;
    expect(assignment?.relayRemote).toBeNull();
  });

  it('a runner older than the relay is still served, so its masters keep fetch and push', async () => {
    await db.execute(
      sql`UPDATE devices SET agent_version = '0.17.141' WHERE id = ${world.deviceId}`,
    );
    const res = await ask(HOST, `${REPO}.git`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.password).toBe(TOKEN);
  });

  it('a relay-capable runner is refused GIT_RELAY_UNAVAILABLE naming the setting, never handed the token', async () => {
    const res = await ask(HOST, `${REPO}.git`);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('GIT_RELAY_UNAVAILABLE');
    expect(String(res.body.detail)).toContain('PUBLIC_API_BASE_URL');
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
  });
});
