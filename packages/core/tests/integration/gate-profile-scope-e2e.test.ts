/**
 * REQ-76 BC-6: a yolo project never refuses a second run for a scope another run holds. The same
 * overlap that standard refuses ISSUE_SCOPE_HELD (issue-scope-e2e) is let through under yolo, and an
 * override putting `scope_hold` back to enforce refuses it again, naming the gate, the override
 * and the key that relaxes it (BC-3, BC-11). The profile is set through the gates door, as a
 * person sets it (BC-12).
 *
 * @direct-test-of packages/core/src/issues/issue-scope.ts
 * @direct-test-of packages/core/src/project-config/gates.ts
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestIssue,
  createTestUser,
} from '../helpers/factories.js';
import { refusalCodes as codes, projectBuiltFrom, type Res } from '../helpers/pattern-world.js';

let projectId = '';
let adminId = '';
let box = '';
let owner = '';
let author = '';

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  const { mintPat } = await import('../../src/credentials/pat.js');
  const admin = await createTestUser({ verified: true });
  const agent = await createTestUser({ kind: 'agent' });
  adminId = admin.id;
  // a project with a document (the gates live in it) and no module label: a design naming no
  // module holds the whole project (ISS-609), so any two designed issues meet
  projectId = await projectBuiltFrom(admin.id, 'github.com/acme/gate-scope');
  const deviceId = await createTestDevice(admin.id);
  await addProjectMember(projectId, admin.id, 'admin');
  await addProjectMember(projectId, agent.id, 'member');
  await bindTestRunner(projectId, deviceId);
  box = (
    await mintPat({
      permissions: ['*'],
      userId: admin.id,
      name: 'box-gate-scope',
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

/** The project's profile and overrides, through the gates door with a reason. */
async function setGates(profile: string, overrides: Record<string, string> = {}): Promise<void> {
  const read = await call(owner, 'GET', `/api/projects/${projectId}/gates`);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  const put = await call(owner, 'PUT', `/api/projects/${projectId}/gates`, {
    baseRevision: read.body.revision,
    profile,
    overrides,
    reason: `planted: ${profile} for the scope-hold test`,
  });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
}

let seq = 0;

/** Two open issues, each with criteria and a design naming no module: they share the project. */
async function pair(): Promise<[string, string]> {
  const keys: string[] = [];
  for (let n = 0; n < 2; n++) {
    seq += 1;
    const issue = await createTestIssue(projectId, adminId, seq, {
      status: 'open',
      createdAt: new Date(),
    });
    const patched = await call(author, 'PATCH', `/api/issues/${issue.id}`, {
      acceptanceCriteria: '1. It holds.\n2. It is refused by name.',
    });
    expect(patched.status).toBe(200);
    const designed = await call(author, 'PUT', `/api/issues/${issue.id}/design`, {
      criteria: [
        { criterion: 1, class: 'observable', pattern: null, proof: 'run it' },
        { criterion: 2, class: 'observable', pattern: null, proof: 'run it red' },
      ],
      modules: [],
      contracts: [],
    });
    expect([designed.status, details(designed)]).toEqual([200, '']);
    keys.push(issue.key);
  }
  return [keys[0] as string, keys[1] as string];
}

const preflight = (key: string) =>
  call(box, 'POST', '/api/devices/me/run-sessions/preflight', { projectId, issueKeys: [key] });

async function opened(key: string): Promise<string> {
  const res = await call(box, 'POST', '/api/devices/me/run-sessions', {
    projectId,
    runId: randomUUID(),
    issueKeys: [key],
    name: key,
  });
  expect([res.status, details(res)]).toEqual([200, '']);
  return String(res.body.sessionId);
}

const close = (sessionId: string) =>
  call(box, 'POST', `/api/devices/me/run-sessions/${sessionId}/close`, { outcome: 'ended' });

describe('REQ-76 BC-6: a held scope under each profile', () => {
  // REQ-79 r6: agents act first; scope_hold is strict's, standard takes both runs
  it('strict refuses the second run ISSUE_SCOPE_HELD', async () => {
    await setGates('strict');
    const [first, second] = await pair();
    const holder = await opened(first);
    const pre = await preflight(second);
    expect([pre.status, codes(pre)]).toEqual([422, ['ISSUE_SCOPE_HELD']]);
    expect(details(pre)).toContain(`${second} shares the whole project with ${first}`);
    expect(details(pre)).toContain('gate profile strict');
    await close(holder);
  });

  it('standard never refuses the second run: both are taken while the scopes meet', async () => {
    await setGates('standard');
    const [first, second] = await pair();
    const holder = await opened(first);
    const pre = await preflight(second);
    expect([pre.status, codes(pre)], details(pre)).toEqual([200, []]);
    const both = await opened(second);
    await close(both);
    await close(holder);
  });

  it('standard with scope_hold overridden to enforce refuses the second run', async () => {
    await setGates('standard', { scope_hold: 'enforce' });
    const [first, second] = await pair();
    const holder = await opened(first);
    const pre = await preflight(second);
    expect([pre.status, codes(pre)]).toEqual([422, ['ISSUE_SCOPE_HELD']]);
    await close(holder);
  });

  it('yolo never refuses the second run: both are taken while the scopes meet', async () => {
    await setGates('yolo');
    const [first, second] = await pair();
    const holder = await opened(first);
    const pre = await preflight(second);
    expect([pre.status, codes(pre)], details(pre)).toEqual([200, []]);
    const both = await opened(second);
    await close(both);
    await close(holder);
  });

  it('yolo with scope_hold overridden to enforce refuses again, naming the gate and its override (BC-3, BC-11)', async () => {
    await setGates('yolo', { scope_hold: 'enforce' });
    const [first, second] = await pair();
    const holder = await opened(first);
    const pre = await preflight(second);
    expect([pre.status, codes(pre)]).toEqual([422, ['ISSUE_SCOPE_HELD']]);
    expect(details(pre)).toContain(
      "Gate scope_hold is enforced by this project's override gates.overrides.scope_hold; gates.overrides.scope_hold relaxes it.",
    );
    await close(holder);
  });
});
