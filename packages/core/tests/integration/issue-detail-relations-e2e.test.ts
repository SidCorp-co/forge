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

let token: string;
let blocker: { id: string; key: string };
let dependent: { id: string; key: string };
let loose: { id: string; key: string };

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
    const relations = res.body.relations as Record<string, { incoming: unknown[]; outgoing: unknown[] }> & {
      blockedBy: unknown[];
    };
    expect(relations.blocks.incoming).toEqual([
      expect.objectContaining({ otherIssueId: blocker.id, blocking: true }),
    ]);
    expect(relations.blockedBy).toHaveLength(1);
    expect(relations.relates).toEqual({ incoming: [], outgoing: [] });
  });

  it('the blocker names what it holds back, and nothing holds it', async () => {
    const res = await api(token, 'GET', `/api/issues/${blocker.id}`);
    const relations = res.body.relations as Record<string, { incoming: unknown[]; outgoing: unknown[] }> & {
      blockedBy: unknown[];
    };
    expect(relations.blocks.outgoing).toEqual([expect.objectContaining({ otherIssueId: dependent.id })]);
    expect(relations.blockedBy).toEqual([]);
  });

  it('an issue with no edge carries every kind empty, never an absent key', async () => {
    const res = await api(token, 'GET', `/api/issues/${loose.id}`);
    expect(res.body.relations).toMatchObject({ blocks: { incoming: [], outgoing: [] }, blockedBy: [] });
  });
});
