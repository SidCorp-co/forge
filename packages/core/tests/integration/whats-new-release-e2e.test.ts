/**
 * What's new shows the release this instance serves, once per person (REQ-40 BC-10), through the
 * app's own routes against real Postgres. The instance is told what it is (`FORGE_ENVIRONMENT`, the
 * id of its own product project) and which commit it was built from; the release of that project
 * whose commit that is, is the one a person owes a look at, until they close it. A reader who is no
 * member of the project reads its highlights and lines and plays the clip from a short-lived link,
 * and reads nothing else of the release.
 */

import { randomUUID } from 'node:crypto';
import { WHATS_NEW_SEEN_KEY } from '@forge/contracts/product-state';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PRODUCT = vi.hoisted(() => {
  const id = '6d1f5a52-3c0e-4a39-9b7e-0b7c2d1e9a10';
  process.env.FORGE_ENVIRONMENT = 'dev';
  process.env.FORGE_PRODUCT_PROJECT_ID = id;
  process.env.SOURCE_COMMIT = 'e7af41887a0e90ed541bb0dbfb34d4f9cb4f8510';
  return id;
});

import { db } from '../../src/db/client.js';
import { register } from '../../src/integrations/llm/registry.js';
import type { ChatStreamEvent } from '../../src/integrations/llm/types.js';
import {
  backgroundRefreshesSettled,
  refreshReleaseHighlights,
} from '../../src/release-page/index.js';
import { api, patToken, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';
import { plantLiveBuild } from '../helpers/live-build.js';
import { BUILD, CLIP_BYTES, releasePageWorld } from '../helpers/release-page-world.js';
import { declareProductionDocument, releaseWorld } from '../helpers/release-world.js';

let answers: string[] = [];
register('anthropic', () => ({
  id: 'scripted',
  defaultModel: 'scripted-model',
  async *stream(): AsyncIterable<ChatStreamEvent> {
    yield { type: 'chunk', text: answers.shift() ?? '' };
    yield { type: 'usage', usage: { promptTokens: 90, completionTokens: 40 } };
    yield { type: 'done' };
  },
}));

const DRAFT = JSON.stringify({
  highlights: [
    {
      requirement: 'REQ-1',
      title: 'Visit reminders',
      body: 'Nurses see a reminder before each visit.',
      claims: ['BC-1'],
    },
  ],
});

let ownerId: string;
const projectId = PRODUCT;
const tokens = { owner: '', member: '', agent: '' };
let readerId: string;
let readerToken: string;
let unplant: (() => void) | null = null;
const fx = releaseWorld(() => ({ projectId, ownerId }));
function call(who: keyof typeof tokens, method: 'GET' | 'POST', path: string, body?: unknown) {
  return api(tokens[who], method, `/api/projects/${projectId}${path}`, body);
}
const world = releasePageWorld(() => ({ projectId, ownerId, call, fx }));

afterEach(async () => {
  unplant?.();
  await backgroundRefreshesSettled();
});

beforeEach(async () => {
  unplant = plantLiveBuild(BUILD);
  answers = [];
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  await createTestProject(ownerId, { id: projectId });
  tokens.owner = await userToken(ownerId);
  const member = await createTestUser({ verified: true });
  await addProjectMember(projectId, member.id, 'member');
  tokens.member = await userToken(member.id);
  const agentId = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, agentId, 'admin');
  tokens.agent = await patToken(agentId, [projectId], 'master');
  // a person of the instance who is no member of its product project
  readerId = (await createTestUser({ verified: true })).id;
  readerToken = await userToken(readerId);
  await fx.seedReleaseRunner();
  const bindingId = await fx.declareProduction({}, 'none');
  await declareProductionDocument({
    projectId,
    ownerId,
    bindingId,
    probes: 'none',
    others: { beta: { tier: 'staging', deployment: { mode: 'external' } } },
  });
});

/** The cut release finishes: shipped at the commit this build was made from. */
async function ship(runId: string, commit = BUILD) {
  await db.execute(sql`
    UPDATE pipeline_runs
       SET release_released_at = now(),
           metadata = metadata || ${JSON.stringify({
             source: 'release-batch',
             finish: { requestId: randomUUID(), state: 'finished', commit, version: 1 },
           })}::jsonb
     WHERE id = ${runId}
  `);
}

const summary = (token = readerToken) => api(token, 'GET', '/api/me/whats-new/summary');
const feed = (token = readerToken) => api(token, 'GET', '/api/me/whats-new');
const mark = (
  release: { environment: string; version: string } | null,
  token = readerToken,
  at = new Date(),
) =>
  api(token, 'PUT', `/api/me/product-state/${WHATS_NEW_SEEN_KEY}`, {
    value: {
      at: at.toISOString(),
      ...(release ? { release: { ...release, at: at.toISOString() } } : {}),
    },
  });

async function servedWorld() {
  const w = await world.releaseWorldOfFour();
  answers = [DRAFT];
  expect(await refreshReleaseHighlights(projectId, w.runId)).toBe('drafted');
  await ship(w.runId);
  return w;
}

describe('the release this build is, is the one a person owes a look at', () => {
  it('serves nothing while no shipped release carries the commit this build was made from', async () => {
    await world.releaseWorldOfFour();
    const s = await summary();
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body).toEqual({ environment: 'dev', release: null });
    expect((await feed()).body).toEqual({ environment: 'dev', release: null });
  });

  it('serves a release shipped at another commit as nothing, never as the nearest one', async () => {
    const w = await world.releaseWorldOfFour();
    await ship(w.runId, '3b1c2d4e5f60718293a4b5c6d7e8f90112233445');
    expect((await summary()).body).toEqual({ environment: 'dev', release: null });
  });

  it('owes the serving release, with its highlight and lines, and the clip plays from a link made for the reader', async () => {
    await servedWorld();
    expect((await summary()).body).toEqual({
      environment: 'dev',
      release: { version: '0.1.0', owed: true },
    });
    const f = await feed();
    expect(f.status, JSON.stringify(f.body)).toBe(200);
    const release = f.body.release as {
      version: string;
      owed: boolean;
      releasedAt: string | null;
      highlights: { state: string; highlights: Array<{ title: string; media: { url: string } }> };
      changes: Array<{ kind: string; line: string }>;
    };
    expect(release).toMatchObject({ version: '0.1.0', owed: true });
    expect(release.releasedAt).not.toBeNull();
    expect(release.highlights.state).toBe('drafted');
    expect(release.highlights.highlights.map((h) => h.title)).toEqual(['Visit reminders']);
    expect(release.changes).toEqual([
      { kind: 'new', line: 'Nurses see a reminder before each visit.' },
      { kind: 'fixed', line: 'A visit report keeps its filter after a reload.' },
    ]);
    const url = release.highlights.highlights[0]?.media.url ?? '';
    expect(url).toMatch(/^\/api\/uploads\/download\//);
    const clip = await fetchBytes(url);
    expect(clip.status).toBe(200);
    expect(Buffer.from(clip.bytes).equals(CLIP_BYTES)).toBe(true);
  });

  it('shows a person who is no member of the project nothing of the release page but its highlights and lines', async () => {
    await servedWorld();
    const f = await feed();
    expect(Object.keys(f.body.release as object).sort()).toEqual([
      'changes',
      'highlights',
      'owed',
      'releasedAt',
      'version',
    ]);
    expect(JSON.stringify(f.body)).not.toMatch(/knownIssues|requirements|actionRequired|technical/);
    const page = await api(readerToken, 'GET', `/api/projects/${projectId}/releases/0.1.0/page`);
    expect([403, 404]).toContain(page.status);
  });
});

async function fetchBytes(path: string): Promise<{ status: number; bytes: ArrayBuffer }> {
  const { app } = await import('../../src/index.js');
  const res = await app.fetch(new Request(`http://forge.test${path}`));
  return { status: res.status, bytes: await res.arrayBuffer() };
}

describe('closing it writes a mark, and the mark is the release seen in this environment', () => {
  it('is no longer owed to the person who closed it, and still owed to another', async () => {
    await servedWorld();
    const r = await mark({ environment: 'dev', version: '0.1.0' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await summary()).body).toEqual({
      environment: 'dev',
      release: { version: '0.1.0', owed: false },
    });
    expect(((await feed()).body.release as { owed: boolean }).owed).toBe(false);
    const other = await userToken((await createTestUser({ verified: true })).id);
    expect(((await summary(other)).body.release as { owed: boolean }).owed).toBe(true);
  });

  it('refuses a release this instance does not serve, by name, and keeps the person owed', async () => {
    await servedWorld();
    const r = await mark({ environment: 'dev', version: '0.2.0' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('RELEASE_SEEN_NOT_SERVING');
    expect(JSON.stringify(r.body)).toContain('serves release 0.1.0, not 0.2.0');
    expect(((await summary()).body.release as { owed: boolean }).owed).toBe(true);
  });

  it('refuses a mark from another environment, by name', async () => {
    await servedWorld();
    const r = await mark({ environment: 'beta', version: '0.1.0' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('RELEASE_SEEN_NOT_SERVING');
    const refusals = (r.body.error as { refusals: Array<{ detail: string }> }).refusals;
    expect(refusals[0]?.detail).toContain('environment "beta", but this instance is "dev"');
  });

  it('refuses a mark naming a release while this instance serves none', async () => {
    await world.releaseWorldOfFour();
    const r = await mark({ environment: 'dev', version: '0.1.0' });
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain('serves no release');
  });

  it('opens nothing after a rollback, and again in an environment the person has not seen', async () => {
    await servedWorld();
    const store = (value: unknown) =>
      db.execute(sql`
        INSERT INTO user_product_state (user_id, key, value)
        VALUES (${readerId}, ${WHATS_NEW_SEEN_KEY}, ${JSON.stringify(value)}::jsonb)
        ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value
      `);
    const at = new Date().toISOString();
    // a person who saw a newer release here: the build now serving is older, so nothing is owed
    await store({ at, release: { environment: 'dev', version: '0.2.0', at } });
    expect(((await summary()).body.release as { owed: boolean }).owed).toBe(false);
    // the same version seen elsewhere is another count
    await store({ at, release: { environment: 'beta', version: '0.9.0', at } });
    expect(((await summary()).body.release as { owed: boolean }).owed).toBe(true);
  });

  it("keeps a mark from before What's new read releases as one that names none, so the release is owed", async () => {
    await servedWorld();
    expect((await mark(null)).status).toBe(200);
    expect(((await summary()).body.release as { owed: boolean }).owed).toBe(true);
  });
});
