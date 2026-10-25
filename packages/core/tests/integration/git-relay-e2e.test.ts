/**
 * REQ-73 BC-5: agents use a connection through Forge and never hold its credential. A GitLab
 * connection's token used to be handed to every box's git credential helper as is; now a box's git
 * reaches the repository through Forge's relay holding only an hour-long ticket, and the token is
 * added in core to each relayed request.
 *
 * Driven through the doors a box uses — the credential helper's ask, the provision and assignment
 * reads, and git's own smart-HTTP requests at `/api/git/…` — against real Postgres. The GitLab
 * host is a planted `fetch` that records what reached it.
 */

import { sql } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { app } from '../../src/index.js';
import { registerAllIntegrations } from '../../src/integration-registry.js';
import { PRE_RELAY_RUNNER_AMNESTY } from '../../src/integrations/source-host/host-credential.js';
import { encryptJson } from '../../src/integrations/vault.js';
import { api } from '../helpers/api.js';
import { HOST, REPO, seedRelayWorld, TOKEN } from '../helpers/git-relay-world.js';

vi.hoisted(() => {
  // the connection's token is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
  // the public origin a relayed checkout's origin names
  process.env.PUBLIC_API_BASE_URL = 'https://forge.example';
});

const RELAY = `https://forge.example/api/git/${HOST}/${REPO}.git`;

interface Reached {
  url: string;
  method: string;
  authorization: string | null;
  gitProtocol: string | null;
  body: string;
}

const world = { projectId: '', deviceId: '', boxToken: '', bindingId: '', connectionId: '' };

let reached: Reached[] = [];
let hostAnswers = 200;

beforeAll(() => {
  registerAllIntegrations();
});

beforeEach(async () => {
  reached = [];
  hostAnswers = 200;
  Object.assign(world, await seedRelayWorld());

  // the GitLab host: records every request the relay sends it, answers as smart HTTP does
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input as string | URL | Request, init);
    if (new URL(req.url).host !== HOST) return real(input, init);
    reached.push({
      url: req.url,
      method: req.method,
      authorization: req.headers.get('authorization'),
      gitProtocol: req.headers.get('git-protocol'),
      body: req.body ? await req.text() : '',
    });
    if (hostAnswers !== 200)
      return new Response('HTTP Basic: Access denied', { status: hostAnswers });
    const advertising = req.url.includes('/info/refs');
    return new Response(advertising ? '001e# service=git-upload-pack\n0000' : 'PACK-BYTES', {
      status: 200,
      headers: {
        'content-type': advertising
          ? 'application/x-git-upload-pack-advertisement'
          : 'application/x-git-upload-pack-result',
        'set-cookie': '_gitlab_session=abc',
      },
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const ask = (host: string, path: string) =>
  api(world.boxToken, 'POST', '/api/devices/me/git-credential', { host, path, protocol: 'https' });

const basic = (password: string) =>
  `Basic ${Buffer.from(`forge-relay:${password}`).toString('base64')}`;

/** git's own request at the relay, as `git fetch` sends it. */
const git = (path: string, init: { method?: string; ticket?: string; body?: string } = {}) =>
  app.fetch(
    new Request(`http://forge.test/api/git/${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'git-protocol': 'version=2',
        ...(init.ticket ? { authorization: basic(init.ticket) } : {}),
        ...(init.body !== undefined
          ? { 'content-type': 'application/x-git-upload-pack-request' }
          : {}),
      },
      ...(init.body !== undefined ? { body: init.body } : {}),
    }),
  );

async function ticket(): Promise<string> {
  const res = await ask('forge.example', `api/git/${HOST}/${REPO}.git`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.password as string;
}

describe('REQ-73 BC-5: the GitLab connection token never leaves Forge', () => {
  it('a direct ask for the host is refused GIT_THROUGH_FORGE naming the relay, and no token is in the answer', async () => {
    const res = await ask(HOST, `${REPO}.git`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('GIT_THROUGH_FORGE');
    expect(String(res.body.detail)).toContain(`git remote set-url origin ${RELAY}`);
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
  });

  it('an ask for the relay URL is handed an hour-long ticket that is not the token', async () => {
    const res = await ask('forge.example', `api/git/${HOST}/${REPO}.git`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.username).toBe('forge-relay');
    expect(res.body.password).not.toContain(TOKEN);
    const lasts = Date.parse(res.body.expiresAt as string) - Date.now();
    expect(lasts).toBeGreaterThan(59 * 60_000);
    expect(lasts).toBeLessThanOrEqual(60 * 60_000);
  });

  it('a box is provisioned and assigned with origin at the relay, never at the host', async () => {
    const provisions = await api(world.boxToken, 'GET', '/api/devices/me/provisions');
    expect(provisions.status, JSON.stringify(provisions.body)).toBe(200);
    const [row] = provisions.body as unknown as Array<{ repoUrl: string; hostCredential: boolean }>;
    expect(row?.repoUrl).toBe(RELAY);
    expect(row?.hostCredential).toBe(true);

    const runners = await api(world.boxToken, 'GET', '/api/devices/me/runners');
    const [assignment] = runners.body as unknown as Array<{
      repository: string;
      relayRemote: string;
    }>;
    expect(assignment?.repository).toBe(`${HOST}/${REPO}`);
    expect(assignment?.relayRemote).toBe(RELAY);
  });
});

describe('REQ-73 BC-5 transition: a runner older than the relay keeps git until it updates (PRE_RELAY_RUNNER_AMNESTY)', () => {
  const reporting = (version: string | null) =>
    db.execute(sql`UPDATE devices SET agent_version = ${version} WHERE id = ${world.deviceId}`);

  it('a runner reporting 0.17.x is still served the connection token on a direct ask', async () => {
    await reporting('0.17.142');
    const res = await ask(HOST, `${REPO}.git`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ username: 'oauth2', password: TOKEN });
  });

  it('a device that reports no version counts as old, and an unreadable one too', async () => {
    for (const version of [null, 'dev-build']) {
      await reporting(version);
      const res = await ask(HOST, `${REPO}.git`);
      expect(res.status, `${version}: ${JSON.stringify(res.body)}`).toBe(200);
      expect(res.body.password).toBe(TOKEN);
    }
  });

  it('a runner at or past the floor is refused GIT_THROUGH_FORGE, whatever patch it is on', async () => {
    for (const version of [PRE_RELAY_RUNNER_AMNESTY, '0.18.7', '1.0.0']) {
      await reporting(version);
      const res = await ask(HOST, `${REPO}.git`);
      expect(res.status, version).toBe(409);
      expect(res.body.code).toBe('GIT_THROUGH_FORGE');
      expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    }
  });
});

describe("REQ-73 BC-5: git's smart HTTP goes through the relay with the token added in core", () => {
  it('ref discovery and a fetch reach the host with the connection credential, and its cookie stays in core', async () => {
    const t = await ticket();
    const refs = await git(`${HOST}/${REPO}.git/info/refs?service=git-upload-pack`, { ticket: t });
    expect(refs.status).toBe(200);
    expect(refs.headers.get('content-type')).toBe('application/x-git-upload-pack-advertisement');
    expect(refs.headers.get('set-cookie')).toBeNull();
    expect(await refs.text()).toContain('# service=git-upload-pack');

    const pack = await git(`${HOST}/${REPO}.git/git-upload-pack`, {
      method: 'POST',
      ticket: t,
      body: '0032want 0123456789012345678901234567890123456789\n0000',
    });
    expect(pack.status).toBe(200);
    expect(await pack.text()).toBe('PACK-BYTES');

    const opened = `Basic ${Buffer.from(`oauth2:${TOKEN}`).toString('base64')}`;
    expect(reached.map((r) => [r.method, r.url, r.authorization, r.gitProtocol])).toEqual([
      ['GET', `https://${HOST}/${REPO}.git/info/refs?service=git-upload-pack`, opened, 'version=2'],
      ['POST', `https://${HOST}/${REPO}.git/git-upload-pack`, opened, 'version=2'],
    ]);
    expect(reached[1]?.body).toBe('0032want 0123456789012345678901234567890123456789\n0000');
  });

  it('a request with no ticket, a forged one or a PAT is challenged so git asks its helper, and nothing is relayed', async () => {
    for (const t of [undefined, 'not-a-ticket', world.boxToken]) {
      const res = await git(`${HOST}/${REPO}.git/info/refs?service=git-upload-pack`, {
        ...(t ? { ticket: t } : {}),
      });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toMatch(/^Basic realm="Forge git relay"/);
      expect(((await res.json()) as { code: string }).code).toBe('GIT_RELAY_UNAUTHENTICATED');
    }
    expect(reached).toEqual([]);
  });

  it('a binding switched off stops a live ticket at once: GIT_RELAY_FORBIDDEN, nothing relayed', async () => {
    const t = await ticket();
    await db.execute(
      sql`UPDATE integration_bindings SET active = false WHERE id = ${world.bindingId}`,
    );
    const res = await git(`${HOST}/${REPO}.git/info/refs?service=git-upload-pack`, { ticket: t });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('GIT_RELAY_FORBIDDEN');
    expect(reached).toEqual([]);
  });

  it('a ticket for one repository opens no other behind the same relay', async () => {
    const t = await ticket();
    const res = await git(`${HOST}/acme/other.git/info/refs?service=git-upload-pack`, {
      ticket: t,
    });
    expect(res.status).toBe(403);
    expect(reached).toEqual([]);
  });

  it('anything but smart HTTP is refused GIT_RELAY_PATH_UNKNOWN before a ticket is read', async () => {
    for (const path of [`${HOST}/${REPO}.git/HEAD`, `${HOST}/${REPO}/-/raw/main/README.md`]) {
      const res = await git(path);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { code: string }).code).toBe('GIT_RELAY_PATH_UNKNOWN');
    }
    expect(reached).toEqual([]);
  });

  it('the host refusing the connection credential is GIT_RELAY_UPSTREAM_REFUSED, never a 401 git would retry', async () => {
    const t = await ticket();
    hostAnswers = 401;
    const res = await git(`${HOST}/${REPO}.git/info/refs?service=git-upload-pack`, { ticket: t });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string; detail: string };
    expect(body.code).toBe('GIT_RELAY_UPSTREAM_REFUSED');
    expect(body.detail).not.toContain(TOKEN);
  });

  it('a connection holding no token is refused GIT_RELAY_UPSTREAM_REFUSED by name, and nothing is relayed', async () => {
    const t = await ticket();
    await db.execute(
      sql`UPDATE integration_connections SET secrets_enc = ${encryptJson({})} WHERE id = ${world.connectionId}`,
    );
    const res = await git(`${HOST}/${REPO}.git/info/refs?service=git-upload-pack`, { ticket: t });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string; detail: string };
    expect(body.code).toBe('GIT_RELAY_UPSTREAM_REFUSED');
    expect(body.detail).toContain('holds no GitLab access token');
    expect(reached).toEqual([]);
  });
});
