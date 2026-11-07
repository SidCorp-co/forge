// ISS-1104 (FB-553): an agent's token is fenced to its project, and three refusals sent it to a door
// that same token is refused at: an account route said "use a token with no project list", a
// missing grant said "mint a token", and a decision written to memory named the organisation's
// knowledge. Each refusal now names a door its caller's own token opens, or says a person is
// needed and how this token asks one; a person's unfenced token keeps the person's way.
// Every route a refusal names is called with the same token and must not be refused by the fence
// or the grant.
// @direct-test-of packages/core/src/middleware/pat-rest-surface.ts
// @direct-test-of packages/core/src/credentials/pat-remedy.ts
// @direct-test-of packages/core/src/memory/write-service.ts
// @direct-test-of packages/core/src/lib/authz.ts

import { beforeAll, describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { type ApiResponse, api, patToken, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestIssue,
  createTestProject,
  createTestUser,
} from '../helpers/factories.js';

let projectId = '';
let orgId = '';
let issueId = '';
let agentId = '';
let personId = '';

beforeAll(async () => {
  personId = (await createTestUser({ verified: true })).id;
  agentId = (await createTestUser({ kind: 'agent' })).id;
  const project = await createTestProject(personId);
  projectId = project.id;
  orgId = project.orgId;
  await addProjectMember(projectId, personId, 'owner');
  await addProjectMember(projectId, agentId, 'member');
  issueId = (
    await createTestIssue(projectId, personId, 1, { status: 'open', createdAt: new Date() })
  ).id;
});

const textOf = (res: ApiResponse): string =>
  String(res.body.message ?? res.body.detail ?? JSON.stringify(res.body));
const codeOf = (res: ApiResponse): string => String(res.body.code ?? '');

const ROUTE_NAMED = /\b(GET|POST|PUT|PATCH|DELETE) (\/api\/[^\s,;)]+)/g;

/** Every route a refusal names, its placeholders filled for this world. */
function doorsNamed(text: string): Array<{ method: ApiMethod; path: string }> {
  return [...text.matchAll(ROUTE_NAMED)].map((m) => ({
    method: m[1] as ApiMethod,
    path: (m[2] as string)
      .replace('<orgId>', orgId)
      .replace('<slug>', 'iss1104-door')
      .replace(/[.:]$/, ''),
  }));
}
type ApiMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** A route the token's fence or grant refuses: what the refusal must never send its caller to. */
async function refusedAtTheDoor(token: string, door: { method: ApiMethod; path: string }) {
  // an empty body is never a valid write, so a door that opens answers its own 400 and writes nothing
  const res = await api(token, door.method, door.path, door.method === 'GET' ? undefined : {});
  return res.status === 403 && codeOf(res).startsWith('PAT_') ? codeOf(res) : null;
}

async function expectEveryDoorOpens(token: string, text: string, atLeast: number) {
  const doors = doorsNamed(text);
  expect(doors.length, `routes named in: ${text}`).toBeGreaterThanOrEqual(atLeast);
  for (const door of doors) {
    expect(await refusedAtTheDoor(token, door), `${door.method} ${door.path} in: ${text}`).toBe(
      null,
    );
  }
}

describe("an agent's fenced token refused an account route", () => {
  it('is told a person makes the change and how it asks one, at a door it opens', async () => {
    const token = await patToken(agentId, [projectId], 'agent run');
    const res = await api(token, 'PUT', `/api/orgs/${orgId}/knowledge/house-rule`, {
      kind: 'rule',
      title: 'House rule',
      body: 'x',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(codeOf(res)).toBe('PAT_ACCOUNT_ROUTE');
    const text = textOf(res);
    expect(text).not.toContain('Use a token with no project list');
    expect(text).toContain('A person signed in to Forge makes this change');
    expect(text).toContain('POST /api/questions');
    await expectEveryDoorOpens(token, text, 1);
  });

  it('says plainly it cannot ask either where its grant holds no questions:write', async () => {
    const { plaintext } = await mintPat({
      permissions: ['orgs:write'],
      userId: agentId,
      name: 'no questions',
      projectIds: [projectId],
      grantEpoch: 3,
    });
    const res = await api(plaintext, 'PUT', `/api/orgs/${orgId}/knowledge/house-rule`, {});
    expect(codeOf(res), JSON.stringify(res.body)).toBe('PAT_ACCOUNT_ROUTE');
    expect(textOf(res)).toContain("not granted 'questions:write'");
    expect(doorsNamed(textOf(res))).toEqual([{ method: 'POST', path: '/api/questions' }]);
    expect(await refusedAtTheDoor(plaintext, { method: 'POST', path: '/api/questions' })).toBe(
      'PAT_PERMISSION_REQUIRED',
    );
  });
});

describe('a token missing the grant a route needs', () => {
  it("sends an agent's token to a person through the question door it holds", async () => {
    const { plaintext } = await mintPat({
      permissions: ['knowledge:read', 'questions:write'],
      userId: agentId,
      name: 'narrow run',
      projectIds: [projectId],
    });
    const res = await api(plaintext, 'POST', '/api/memory', {
      projectId,
      source: 'note',
      sourceRef: 'iss1104-grant',
      textContent: 'A note the token is not granted to write.',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(codeOf(res)).toBe('PAT_PERMISSION_REQUIRED');
    const text = textOf(res);
    expect(text).not.toContain('Mint a token');
    expect(text).toContain('A person signed in to Forge grants it');
    await expectEveryDoorOpens(plaintext, text, 1);
    const asked = await api(plaintext, 'POST', '/api/questions', {
      issueId,
      prompt: 'Grant this run knowledge:write so it can record what it learns.',
      options: [
        {
          id: 'grant',
          label: 'Grant it',
          authority: 'admin',
          bindsTo: 'project',
          executedBy: 'human',
        },
      ],
      recommendedOptionId: 'grant',
      serious: true,
    });
    expect(codeOf(asked), JSON.stringify(asked.body)).not.toMatch(/^PAT_/);
  });

  it("keeps a person's unfenced token on minting one", async () => {
    const { plaintext } = await mintPat({
      permissions: ['knowledge:read'],
      userId: personId,
      name: 'laptop',
    });
    const res = await api(plaintext, 'POST', '/api/memory', {
      projectId,
      source: 'note',
      sourceRef: 'iss1104-person',
      textContent: 'A note the token is not granted to write.',
    });
    expect(codeOf(res), JSON.stringify(res.body)).toBe('PAT_PERMISSION_REQUIRED');
    expect(textOf(res)).toContain('Mint a token that includes it');
  });
});

describe('a decision written to memory', () => {
  const decision = (token: string, ref: string) =>
    api(token, 'POST', '/api/memory', {
      projectId,
      source: 'decision',
      sourceRef: ref,
      textContent: 'Releases are cut on Tuesdays.',
    });

  it("names the project's rule to a fenced token, with its project filled in, and no org door", async () => {
    const token = await patToken(agentId, [projectId], 'agent decision');
    const res = await decision(token, 'iss1104-fenced');
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(codeOf(res)).toBe('MEMORY_DECISION_NOT_MEMORY');
    const text = String(res.body.detail);
    await expectEveryDoorOpens(token, text, 2);
    expect(text).toContain(`PUT /api/projects/${projectId}/knowledge/<slug> with kind rule`);
    expect(text).not.toContain('/api/orgs/');
  });

  it("still names the organisation's knowledge to a person's session", async () => {
    const res = await decision(await userToken(personId), 'iss1104-person');
    expect(codeOf(res), JSON.stringify(res.body)).toBe('MEMORY_DECISION_NOT_MEMORY');
    expect(String(res.body.detail)).toContain('PUT /api/orgs/<orgId>/knowledge/<slug>');
  });
});
