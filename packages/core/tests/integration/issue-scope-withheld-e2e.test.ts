/**
 * A takeable issue the admissible list withholds because another live run holds its scope says so
 * (REQ-36 BC-5, ISS-644): its standing and its REST issue-list row read withheld ISSUE_SCOPE_HELD,
 * naming the holding issue and its run, and read nothing once that run ends. A withholding is said
 * only where the project's profile enforces its gate, the same gates the admissible list asks
 * (REQ-76), so a yolo project, whose list hands the row out, reads it withheld by nothing. The other
 * gates keep their own codes.
 *
 * @direct-test-of packages/core/src/issues/standing-withheld-read.ts
 * @direct-test-of packages/core/src/issues/standing-held.ts
 * @direct-test-of packages/core/src/issues/standing-read.ts
 * @direct-test-of packages/core/src/issues/issue-scope.ts
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { THIS_REPOSITORY } from '../../src/lib/this-repository.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestIssue,
  createTestUser,
} from '../helpers/factories.js';
import { projectBuiltFrom, type Res } from '../helpers/pattern-world.js';

let projectId = '';
let adminId = '';
let deviceId = '';
let box = '';
let owner = '';
let author = '';
let seq = 0;

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  const { mintPat } = await import('../../src/credentials/pat.js');
  const admin = await createTestUser({ verified: true });
  const agent = await createTestUser({ kind: 'agent' });
  adminId = admin.id;
  // a project with a document (its gates live there) and no module label: a design naming no
  // module holds the whole project (ISS-609), so any two designed issues meet
  projectId = await projectBuiltFrom(admin.id, THIS_REPOSITORY);
  deviceId = await createTestDevice(admin.id);
  await addProjectMember(projectId, admin.id, 'admin');
  await addProjectMember(projectId, agent.id, 'member');
  await bindTestRunner(projectId, deviceId);
  box = (
    await mintPat({
      permissions: ['*'],
      userId: admin.id,
      name: 'box-scope-withheld',
      deviceId,
      projectIds: [projectId],
    })
  ).plaintext;
  owner = await userToken(admin.id);
  author = await userToken(agent.id);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

/** Every run a case opened, closed after it whatever it asserted: a whole-project hold outlives a red. */
const live = new Set<string>();
afterEach(async () => {
  for (const sessionId of live) await close(sessionId);
  live.clear();
});

async function call(
  token: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  path: string,
  body?: unknown,
): Promise<Res> {
  const res = await api(token, method, path, body);
  return { status: res.status, body: res.body as Doc };
}

const details = (res: Res): string =>
  (res.body?.error?.refusals ?? []).map((r: Doc) => r.detail).join(' | ');

// REQ-79 r6: scope_hold and patterns are strict's now; standard here asks for them as overrides
const HELD = { scope_hold: 'enforce', patterns: 'enforce' };

async function setGates(profile: string, overrides: Record<string, string> = {}): Promise<void> {
  const read = await call(owner, 'GET', `/api/projects/${projectId}/gates`);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  const put = await call(owner, 'PUT', `/api/projects/${projectId}/gates`, {
    baseRevision: read.body.revision,
    profile,
    overrides,
    reason: `planted: ${profile} for the scope-withheld test`,
  });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
}

type Issue = { id: string; key: string };

/** An open issue with criteria; `designed` records a design naming no module, so it holds the project. */
async function issue(designed: boolean): Promise<Issue> {
  seq += 1;
  const made = await createTestIssue(projectId, adminId, seq, {
    status: 'open',
    createdAt: new Date(),
  });
  const patched = await call(author, 'PATCH', `/api/issues/${made.id}`, {
    acceptanceCriteria: '1. It holds.\n2. It is refused by name.',
  });
  expect(patched.status).toBe(200);
  if (designed) {
    const res = await call(author, 'PUT', `/api/issues/${made.id}/design`, {
      criteria: [
        { criterion: 1, class: 'observable', pattern: 'api-route', proof: 'run it' },
        { criterion: 2, class: 'observable', pattern: 'api-route', proof: 'run it red' },
      ],
      modules: [],
      contracts: [],
    });
    expect([res.status, details(res)]).toEqual([200, '']);
  }
  return made;
}

async function opened(key: string): Promise<{ sessionId: string; runId: string }> {
  const runId = randomUUID();
  const res = await call(box, 'POST', '/api/devices/me/run-sessions', {
    projectId,
    runId,
    issueKeys: [key],
    name: key,
  });
  expect([res.status, details(res)]).toEqual([200, '']);
  live.add(String(res.body.sessionId));
  return { sessionId: String(res.body.sessionId), runId };
}

async function close(sessionId: string): Promise<Res> {
  live.delete(sessionId);
  return call(box, 'POST', `/api/devices/me/run-sessions/${sessionId}/close`, {
    outcome: 'ended',
  });
}

/** The issue's standing, as the issue page reads it. */
async function standingOf(i: Issue): Promise<Doc> {
  const res = await call(author, 'GET', `/api/projects/${projectId}/issues/standing/${i.key}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.standing;
}

/** The issue's row on the REST issue list `forge next` ranks from. */
async function listRowOf(i: Issue): Promise<Doc> {
  const res = await call(author, 'GET', `/api/projects/${projectId}/issues?limit=200`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const row = (res.body.items as Doc[]).find((r) => r.id === i.id);
  expect(row, `${i.key} is on the list`).toBeDefined();
  return row as Doc;
}

async function admittedKeys(): Promise<string[]> {
  const { readAdmissibleIssues } = await import('../../src/devices/admissible.js');
  const { items } = await readAdmissibleIssues({ deviceId, projectId });
  return items.map((i) => String(i.issueKey));
}

describe('an issue another live run holds the scope of', () => {
  it('criterion 1, criterion 2: reads withheld ISSUE_SCOPE_HELD naming the holder and its run, and nothing once it ends', async () => {
    await setGates('standard', HELD);
    const holder = await issue(true);
    const held = await issue(true);
    const run = await opened(holder.key);
    expect(await admittedKeys()).not.toContain(held.key);

    const standing = await standingOf(held);
    expect(standing.withheld).toMatchObject({ code: 'ISSUE_SCOPE_HELD', holder: holder.key });
    expect(standing.withheld.detail).toContain(`shares the whole project with ${holder.key}`);
    expect(standing.withheld.detail).toContain(`held by live run ${run.runId}`);
    expect(standing.withheld.detail).toContain('until that run ends');
    // it waits on the holding issue's run, not on a person
    expect(standing.attentionGroup).toBe('stuck');
    expect(standing.waitingOn).toMatchObject({ kind: 'issue', who: holder.key, ref: holder.key });
    expect(standing.waitingOn.rule).toContain('ISSUE_SCOPE_HELD');

    const row = await listRowOf(held);
    expect(row.withheld).toEqual(standing.withheld);

    // the holding issue itself is not held by its own run
    expect((await standingOf(holder)).withheld).toBeNull();
    expect((await listRowOf(holder)).withheld).toBeNull();

    expect((await close(run.sessionId)).status).toBe(200);
    expect(await admittedKeys()).toContain(held.key);
    expect((await standingOf(held)).withheld).toBeNull();
    expect((await listRowOf(held)).withheld).toBeNull();
  });

  it('criterion 1: a row with no design declares no scope and reads withheld by nothing', async () => {
    await setGates('standard', HELD);
    const holder = await issue(true);
    const bare = await issue(false);
    const run = await opened(holder.key);
    expect(await admittedKeys()).toContain(bare.key);
    expect((await standingOf(bare)).withheld).toBeNull();
    expect((await listRowOf(bare)).withheld).toBeNull();
    await close(run.sessionId);
  });
});

describe('a gate the profile turns off withholds nothing on the standing or the list (REQ-76)', () => {
  it('criterion 3: reads the scope hold and a pending pattern withheld under standard with both enforced, and neither under yolo', async () => {
    await setGates('standard', HELD);
    const holder = await issue(true);
    const held = await issue(true);
    const pending = await issue(false);
    const named = await call(author, 'POST', `/api/issues/${pending.id}/patterns`, {
      pattern: 'scope-withheld-door',
      summary: 'A door of its own; no catalogued pattern reads it',
    });
    expect(named.status, JSON.stringify(named.body)).toBe(201);
    const run = await opened(holder.key);

    // the other gates keep their own codes
    expect((await standingOf(pending)).withheld?.code).toBe('PATTERN_REVIEW_PENDING');
    expect((await listRowOf(pending)).withheld?.code).toBe('PATTERN_REVIEW_PENDING');
    expect((await standingOf(held)).withheld?.code).toBe('ISSUE_SCOPE_HELD');

    await setGates('yolo');
    const admitted = await admittedKeys();
    expect(admitted).toEqual(expect.arrayContaining([held.key, pending.key]));
    for (const i of [held, pending]) {
      expect((await standingOf(i)).withheld, `${i.key} standing under yolo`).toBeNull();
      expect((await listRowOf(i)).withheld, `${i.key} list row under yolo`).toBeNull();
    }
    await close(run.sessionId);
    await setGates('standard', HELD);
  });
});
