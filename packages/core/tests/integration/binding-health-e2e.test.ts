/**
 * Two projects' source bindings share one GitLab connection, as sidpeak and adminhub-api do on
 * forge-dev (2026-11-05): GitLab holds Forge's hook on adminhub-api's repository and none on
 * sidpeak's. Each project's source standing names its own repository's hook and never the other's,
 * whichever project was probed last; what is the credential's (GitLab refusing the token) reads
 * alike on both (ISS-983). Driven through the routes against real Postgres, GitLab a stub.
 *
 * @direct-test-of packages/core/src/integrations/binding-health.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { inboundWebhookUrl, resolveApiBaseUrl } from '../../src/integrations/index.js';
import { encryptJson } from '../../src/integrations/vault.js';
import { api, userToken } from '../helpers/api.js';
import { testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const HOST = 'gitlab.test';
const ALL_EVENTS = { push_events: true, merge_requests_events: true, pipeline_events: true };

interface Side {
  projectId: string;
  slug: string;
  bindingId: string;
  repository: string;
}

const world = {
  session: '',
  connectionId: '',
  hooked: null as Side | null,
  bare: null as Side | null,
};
/** What GitLab answers: every project read refused 401 when the token is not recognised. */
let tokenRefused = false;

const hooked = () => world.hooked as Side;
const bare = () => world.bare as Side;

/** GitLab as the token sees it: both repositories visible, Forge's hook on the hooked one alone. */
function stubGitLab(): void {
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.host !== HOST) throw new Error(`the test reached ${url.host}, which is not GitLab`);
    if (tokenRefused) return Response.json({ message: '401 Unauthorized' }, { status: 401 });
    const path = decodeURIComponent(url.pathname.replace(/^\/api\/v4\/projects\//, ''));
    const side = [hooked(), bare()].find((s) => path.startsWith(s.repository));
    if (!side) return Response.json({ message: '404 Project Not Found' }, { status: 404 });
    if (path.endsWith('/hooks')) {
      if (side !== hooked()) return Response.json([]);
      const ours = inboundWebhookUrl(resolveApiBaseUrl() as string, side.slug);
      return Response.json([{ url: ours, ...ALL_EVENTS }]);
    }
    return Response.json({ path_with_namespace: side.repository, default_branch: 'main' });
  });
}

async function bindSide(owner: string, repository: string): Promise<Side> {
  const project = await createTestProject(owner);
  await addProjectMember(project.id, owner, 'owner');
  await seedProjectDocument(project.id, owner, {
    environments: {},
    source: {
      type: 'git',
      git: { repository: `${HOST}/${repository}`, defaultBranch: 'main', branches: ['main'] },
    },
  });
  const bindingId = randomUUID();
  await db.execute(sql`
    INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, active, config)
    VALUES (${bindingId}, ${world.connectionId}, ${project.id}, 'gitlab', 'source', true,
            ${JSON.stringify({ projectPath: repository })}::jsonb)
  `);
  return { projectId: project.id, slug: project.slug, bindingId, repository };
}

beforeAll(() => {
  testEnv();
});

beforeEach(async () => {
  await truncateAll();
  tokenRefused = false;
  const owner = (await createTestUser({ verified: true })).id;
  world.session = await userToken(owner);
  world.connectionId = randomUUID();
  await db.execute(sql`
    INSERT INTO integration_connections (id, owner_type, owner_id, provider, active, config, secrets_enc)
    VALUES (${world.connectionId}, 'user', ${owner}, 'gitlab', true,
            ${JSON.stringify({ baseUrl: `https://${HOST}` })}::jsonb,
            ${encryptJson({ token: 'glpat-one-token-two-projects' })})
  `);
  world.hooked = await bindSide(owner, 'sidcorp-it/adminhub-api');
  world.bare = await bindSide(owner, 'sidcorp-it/sidpeak');
  stubGitLab();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function probe(side: Side): Promise<void> {
  const res = await api(
    world.session,
    'POST',
    `/api/projects/${side.projectId}/integrations/${side.bindingId}/test`,
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

/** Every place a project reads its source standing: the integrations list, the source report, its card. */
async function standing(side: Side) {
  const list = await api(world.session, 'GET', `/api/projects/${side.projectId}/integrations`);
  expect(list.status, JSON.stringify(list.body)).toBe(200);
  const item = (
    list.body.items as Array<{
      id: string;
      lastHealthStatus: string | null;
      lastHealthDetail: string | null;
    }>
  ).find((i) => i.id === side.bindingId);
  const source = await api(
    world.session,
    'GET',
    `/api/projects/${side.projectId}/integrations/source`,
  );
  expect(source.status, JSON.stringify(source.body)).toBe(200);
  const report = (
    source.body.bindings as Array<{
      bindingId: string;
      connectionProbeStatus: string | null;
      healthDetail: string | null;
      observedWebhookUrl: string | null;
    }>
  ).find((b) => b.bindingId === side.bindingId);
  const status = await api(
    world.session,
    'GET',
    `/api/projects/${side.projectId}/integrations/status`,
  );
  expect(status.status, JSON.stringify(status.body)).toBe(200);
  const card = (status.body.cards as Array<{ key: string; status: string; detail: string }>).find(
    (c) => c.key === 'gitlab:repository',
  );
  return {
    status: item?.lastHealthStatus ?? null,
    detail: item?.lastHealthDetail ?? null,
    reportStatus: report?.connectionProbeStatus ?? null,
    reportDetail: report?.healthDetail ?? null,
    observed: report?.observedWebhookUrl ?? null,
    card: card ? `${card.status}: ${card.detail}` : null,
    said: JSON.stringify([item, report, card]),
  };
}

const doorOf = (side: Side) => `/api/webhooks/in/${side.slug}`;

describe('one GitLab connection, two projects: each reads its own hook (ISS-983)', () => {
  it('PLANT: probed bare then hooked, the bare project names its own missing hook and the hooked one reads healthy', async () => {
    await probe(bare());
    await probe(hooked());

    const a = await standing(hooked());
    const b = await standing(bare());

    expect(b.status).toBe('degraded');
    expect(b.detail).toContain(`no GitLab webhook calls`);
    expect(b.detail).toContain(doorOf(bare()));
    expect(b.reportStatus).toBe('degraded');
    expect(b.reportDetail).toContain(doorOf(bare()));
    expect(b.observed).toBeNull();
    expect(b.card).toBe('attention: read through GitLab — last health: degraded');

    expect(a.status).toBe('ok');
    expect(a.detail).toBeNull();
    expect(a.reportStatus).toBe('ok');
    expect(a.observed).toContain(doorOf(hooked()));
    expect(a.said).not.toContain(bare().slug);
    expect(a.card).toBe('connected: read through GitLab — last health: ok');
  });

  it('PLANT: probed hooked then bare (the sidpeak shape), the hooked project never reads the bare one’s missing hook', async () => {
    await probe(hooked());
    await probe(bare());

    const a = await standing(hooked());
    const b = await standing(bare());

    expect(a.status).toBe('ok');
    expect(a.reportStatus).toBe('ok');
    expect(a.observed).toContain(doorOf(hooked()));
    expect(a.said).not.toContain(bare().slug);
    expect(a.said).not.toContain('no GitLab webhook');

    expect(b.status).toBe('degraded');
    expect(b.detail).toContain(doorOf(bare()));
    expect(b.said).not.toContain(hooked().slug);
  });

  it('a credential GitLab refuses reads alike on both bindings, though only one was probed', async () => {
    await probe(hooked());
    await probe(bare());
    tokenRefused = true;
    await probe(bare());

    const a = await standing(hooked());
    const b = await standing(bare());
    for (const side of [a, b]) {
      expect(side.status).toBe('needs_reauth');
      expect(side.detail).toContain('GitLab does not recognise this token');
      expect(side.reportStatus).toBe('needs_reauth');
    }
    expect(a.detail).toBe(b.detail);
    expect(a.said).not.toContain(bare().slug);
  });

  it('once the credential is recognised again, each binding reads its own hook once more', async () => {
    await probe(hooked());
    await probe(bare());
    tokenRefused = true;
    await probe(hooked());
    tokenRefused = false;
    await probe(bare());

    expect((await standing(bare())).status).toBe('degraded');
    // the hooked binding's own reading stands from its last probe that reached GitLab
    expect((await standing(hooked())).status).toBe('ok');
  });

  it('a binding no probe has reached on a healthy connection reads unverified, never the other binding’s verdict', async () => {
    await probe(bare());

    const a = await standing(hooked());
    expect(a.status).toBeNull();
    expect(a.said).not.toContain(bare().slug);
    expect(a.card).toBe('unverified: read through GitLab — never health-checked');
  });
});
