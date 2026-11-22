/**
 * R-5: GET /api/issues/:id carries the issue's relations, keyed by kind with the live gating edges
 * under `blockedBy`, the shape GET /api/issues/:id/dependencies is digested into. A reader of the one
 * issue read no longer reads "nothing blocks" off a key the read never sent.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestIssue,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';

type Directions = { incoming: unknown[]; outgoing: unknown[] };
type Relations = { blocks: Directions; relates: Directions; blockedBy: unknown[] };

let token: string;
let blocker: { id: string; key: string };
let dependent: { id: string; key: string };
let loose: { id: string; key: string };
let elsewhere: { id: string; key: string };

beforeAll(async () => {
  await truncateAll();
  const user = await createTestUser({ verified: true });
  const project = await createTestProject(user.id);
  await addProjectMember(project.id, user.id, 'admin');
  token = await userToken(user.id);
  const at = new Date('2026-10-01T00:00:00Z');
  blocker = await createTestIssue(project.id, user.id, 1, { status: 'open', createdAt: at });
  dependent = await createTestIssue(project.id, user.id, 2, { status: 'open', createdAt: at });
  loose = await createTestIssue(project.id, user.id, 3, { status: 'open', createdAt: at });
  // another project's issue: this user is no member there, as a fenced master is not
  const stranger = await createTestUser({ verified: true });
  const other = await createTestProject(stranger.id);
  elsewhere = await createTestIssue(other.id, stranger.id, 1, { status: 'open', createdAt: at });
  const edge = await api(token, 'POST', `/api/issues/${dependent.id}/dependencies`, {
    dependsOnId: blocker.id,
    kind: 'blocks',
  });
  expect(edge.status, JSON.stringify(edge.body)).toBeLessThan(300);
});

describe('GET /api/issues/:id carries its relations (R-5)', () => {
  it('the held issue names what holds it back, by kind and under blockedBy', async () => {
    const res = await api(token, 'GET', `/api/issues/${dependent.id}`);
    expect(res.status).toBe(200);
    const relations = res.body.relations as Relations;
    expect(relations.blocks.incoming).toEqual([
      expect.objectContaining({ otherIssueId: blocker.id, blocking: true }),
    ]);
    expect(relations.blockedBy).toHaveLength(1);
    expect(relations.relates).toEqual({ incoming: [], outgoing: [] });
  });

  it('the blocker names what it holds back, and nothing holds it', async () => {
    const res = await api(token, 'GET', `/api/issues/${blocker.id}`);
    const relations = res.body.relations as Relations;
    expect(relations.blocks.outgoing).toEqual([
      expect.objectContaining({ otherIssueId: dependent.id }),
    ]);
    expect(relations.blockedBy).toEqual([]);
  });

  it('an issue with no edge carries every kind empty, never an absent key', async () => {
    const res = await api(token, 'GET', `/api/issues/${loose.id}`);
    expect(res.body.relations).toMatchObject({
      blocks: { incoming: [], outgoing: [] },
      blockedBy: [],
    });
  });
});

// ISS-1408: a wait on another project's work is a contract wait, and the door that cannot make the
// edge says so, whether it was handed that project's issue id or a key it could read off a note
describe('POST /api/issues/:id/dependencies across projects names the contract wait (ISS-1408)', () => {
  const namesTheWay = (body: unknown) => {
    const said = JSON.stringify(body);
    expect(said).toContain('POST /api/issues/:id/contract-waits');
    expect(said).toContain('minVersion');
    expect(said).toContain('dueAt?');
  };

  it("another project's issue is refused CROSS_PROJECT, naming the contract-wait door and its body", async () => {
    const res = await api(token, 'POST', `/api/issues/${loose.id}/dependencies`, {
      dependsOnId: elsewhere.id,
      kind: 'blocks',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect((res.body as { error: { code: string } }).error.code).toBe('CROSS_PROJECT');
    namesTheWay(res.body);
  });

  it('a key where the id goes is refused naming the same way, never an edge', async () => {
    const res = await api(token, 'POST', `/api/issues/${loose.id}/dependencies`, {
      dependsOnId: 'ISS-1',
      kind: 'blocks',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    namesTheWay(res.body);
    const read = await api(token, 'GET', `/api/issues/${loose.id}`);
    expect((read.body.relations as Relations).blockedBy).toEqual([]);
  });

  it('a same-project blocks edge is written as before', async () => {
    const res = await api(token, 'POST', `/api/issues/${loose.id}/dependencies`, {
      dependsOnId: blocker.id,
      kind: 'blocks',
      validUntil: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.created).toBe(true);
    // written already expired, it gates nothing, and its answer says so (debt e67f5a86)
    expect(res.body.effects).toMatchObject({ gatesDispatch: false });
    expect((res.body.effects as { note: string }).note).toMatch(/^Retracted/);
  });
});
