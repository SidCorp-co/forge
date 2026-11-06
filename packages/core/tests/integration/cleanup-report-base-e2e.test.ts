/**
 * ISS-912 (FB-482): a cleanup report's base is held to the project's source, and a later report from
 * one fire supersedes the earlier. Planted from forge-dev, 2026-11-02: fire e23d2b1f filed report
 * 571cd8d7, green, at `2d468189ae0c0ba0a7c3a2a4bd2bd1d8b2b17a19`, a sha naming no object in the
 * repository, and 14 s later report f74d6fcc, green, at the real head
 * `2d468189a87a618154af2c873a5e295a876d7901`. Both stood, and the landing rule read the newest.
 *
 * The host is planted (`helpers/cleanup-source.ts`); nothing here calls a real one.
 *
 * @direct-test-of packages/core/src/cleanup/report-base.ts
 * @direct-test-of packages/core/src/cleanup/store.ts
 * @direct-test-of packages/core/src/cleanup/service.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { lastReport } from '../../src/cleanup/store.js';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import { plantSource, resetPlantedSources } from '../helpers/cleanup-source.js';
import { turnCleanupWindowOn } from '../helpers/cleanup-window.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, rows, truncateAll } from '../helpers/factories.js';

vi.mock('../../src/integrations/source-host/index.js', async (original) =>
  (await import('../helpers/cleanup-source.js')).mockedSourceHost(
    await original<typeof import('../../src/integrations/source-host/index.js')>(),
  ),
);

const MISTYPED = '2d468189ae0c0ba0a7c3a2a4bd2bd1d8b2b17a19';
const HEAD = '2d468189a87a618154af2c873a5e295a876d7901';
const OFF_BRANCH = 'e'.repeat(40);

let projectId: string;
let ownerId: string;
let token: string;

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
}, 120_000);

afterAll(async () => {
  resetPlantedSources();
  await closeWorld();
});

beforeEach(async () => {
  await truncateAll();
  resetPlantedSources();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
});

const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
  const res = await api(token, method, path, body);
  return { status: res.status, body: res.body as Doc };
};
const refusals = (res: { body: Doc }): Doc[] => res.body.error?.refusals ?? [];
const report = (body: Doc) =>
  call('POST', `/api/projects/${projectId}/cleanup-reports`, {
    base: { branch: 'dev', sha: HEAD },
    result: 'green',
    cleared: [],
    remains: [],
    ...body,
  });
const listed = async (query = '') =>
  (await call('GET', `/api/projects/${projectId}/cleanup-reports${query}`)).body.reports as Doc[];

describe("a report's base, read on the project's source host (ISS-912)", () => {
  beforeEach(() => {
    plantSource(projectId, { dev: [HEAD], 'feat/elsewhere': [OFF_BRANCH] });
  });

  it('refuses the mistyped sha of fire e23d2b1f by name, its sha and the valid shape, and records nothing', async () => {
    const res = await report({ base: { branch: 'dev', sha: MISTYPED } });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const [refusal, ...rest] = refusals(res);
    expect(rest).toEqual([]);
    expect(refusal).toMatchObject({ code: 'CLEANUP_BASE_NOT_ON_BRANCH', path: '/base/sha' });
    expect(refusal?.detail).toContain(MISTYPED);
    expect(refusal?.detail).toContain('names no commit');
    expect(refusal?.detail).toContain('full 40-hex sha of a commit on `base.branch`');
    expect(await listed('?superseded=include')).toEqual([]);
  });

  it('refuses a sha that is a commit, but not one the named branch holds', async () => {
    const res = await report({ base: { branch: 'dev', sha: OFF_BRANCH } });
    expect(res.status).toBe(422);
    expect(refusals(res)[0]).toMatchObject({ code: 'CLEANUP_BASE_NOT_ON_BRANCH' });
    expect(refusals(res)[0]?.detail).toContain('does not contain');
    expect(refusals(res)[0]?.detail).toContain(OFF_BRANCH);
  });

  it('keeps a report whose sha is a commit on its branch, upper case read as the same commit', async () => {
    const res = await report({ base: { branch: 'dev', sha: HEAD.toUpperCase() } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.report).toMatchObject({
      base: { branch: 'dev', sha: HEAD },
      supersededBy: null,
    });
    expect(res.body.supersedes).toEqual([]);
  });

  it('is refused as uncheckable, never taken on its word, when the host does not answer', async () => {
    plantSource(projectId, { dev: [HEAD] }).fail = new Error('github answered 502');
    const res = await report({});
    expect(res.status).toBe(422);
    expect(refusals(res)[0]).toMatchObject({ code: 'CLEANUP_BASE_UNCHECKABLE' });
    expect(refusals(res)[0]?.detail).toContain('github answered 502');
  });
});

describe('a project with no source host to read (ISS-912)', () => {
  it('is refused by its own name, saying the base cannot be checked there', async () => {
    const res = await report({});
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const [refusal] = refusals(res);
    expect(refusal).toMatchObject({ code: 'CLEANUP_BASE_UNCHECKABLE', path: '/base/sha' });
    expect(refusal?.detail).toContain('cannot be checked on this project');
    expect(refusal?.detail).toContain('no active source host binding');
    expect(refusal?.detail).toContain(HEAD);
    expect(await listed('?superseded=include')).toEqual([]);
  });
});

describe('two reports from one fire (ISS-912)', () => {
  const SECOND = 'f'.repeat(40);
  beforeEach(() => {
    plantSource(projectId, { dev: [HEAD, SECOND] });
  });

  async function fire(): Promise<string> {
    const window = await turnCleanupWindowOn(projectId, ownerId);
    const [run] = await rows<{ id: string }>(sql`
      INSERT INTO schedule_runs (schedule_id, project_id, trigger, status, started_at)
      VALUES (${window}, ${projectId}, 'manual', 'running', now()) RETURNING id`);
    if (!run) throw new Error('no cleanup fire was opened');
    return run.id;
  }

  it('leaves the first superseded and kept, and the list and the landing rule read only the second', async () => {
    const fireId = await fire();
    const first = await report({ fire: fireId });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const second = await report({ fire: fireId, base: { branch: 'dev', sha: SECOND } });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    const [firstId, secondId] = [first.body.report.id, second.body.report.id] as string[];
    expect(second.body.supersedes).toEqual([firstId]);

    expect((await listed()).map((r) => r.id)).toEqual([secondId]);
    const all = await listed('?superseded=include');
    expect(all.find((r) => r.id === firstId)).toMatchObject({ supersededBy: secondId });
    expect(all.find((r) => r.id === secondId)).toMatchObject({ supersededBy: null });

    // the landing rule's read: the second, even where the first is the newer by its clock
    await db.execute(
      sql`UPDATE cleanup_reports SET created_at = now() + interval '1 hour' WHERE id = ${firstId}`,
    );
    expect(await lastReport(db, projectId, 'dev')).toMatchObject({ id: secondId, sha: SECOND });
  });

  it('supersedes nothing when filed without a fire, nor a report of another fire', async () => {
    const [a, b] = [await fire(), await fire()];
    const one = await report({ fire: a });
    const other = await report({ fire: b });
    const loose = await report({});
    expect([one.status, other.status, loose.status]).toEqual([201, 201, 201]);
    expect(other.body.supersedes).toEqual([]);
    expect(loose.body.supersedes).toEqual([]);
    expect(await listed()).toHaveLength(3);
  });
});
