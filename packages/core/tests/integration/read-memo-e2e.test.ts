import { randomUUID } from 'node:crypto';
import { NEEDS_YOU_PERSON_CAP } from '@forge/contracts/steward';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestFeedback,
  createTestIssue,
  createTestProject,
  createTestRequirement,
  createTestUser,
} from '../helpers/factories.js';

// The rail's Needs-you count reads every project the person can see, and every page load asks for
// it. Each project's read asked its access, configuration and prefix again for every list it
// assembled: 105 statements a project, so eight projects held the pool for ~1300 round trips while
// the page's own reads queued behind them. A read request now asks each of those once.
// @direct-test-of packages/core/src/development/needs-you-viewer.ts
// @direct-test-of packages/core/src/development/needs-you-fold.ts

// Amnesty (ISS-495, REQ-41 BC-10, BC-12): the requirement standing every Needs-you read takes now
// reads its stale design follows and its open merge-or-drop question beside its rows, one statement
// each per project, which took the measured read from at most 60 to 61 a project. Ends when those
// two reads join the standing's first wave or the request memo, and the bound returns to 60.
const PER_PROJECT_BOUND = 61;

const queriesOf = (headers: Headers): number => {
  const raw = headers.get('server-timing') ?? '';
  const n = /db;dur=[0-9.]+;desc="(\d+) quer/.exec(raw)?.[1];
  if (n === undefined) throw new Error(`Server-Timing "${raw}" names no query count`);
  return Number(n);
};

/** A question on an issue the owner must answer: a decision of their Needs you (REQ-48 BC-11). */
async function askOwner(projectId: string, issueId: string) {
  const { askQuestion } = await import('../../src/questions/index.js');
  await askQuestion({
    id: randomUUID(),
    projectId,
    issueId,
    prompt: 'Keep the old export format or move to the new one?',
    blockerKind: 'human',
    answer: {
      shape: 'choice',
      options: ['keep', 'move'].map((id) => ({
        id,
        label: id,
        authority: 'writer' as const,
        bindsTo: 'session' as const,
        executedBy: 'agent' as const,
      })),
      recommendedOptionId: 'move',
    },
  });
}

async function personWith(projects: number) {
  const owner = await createTestUser({ verified: true });
  const ids: string[] = [];
  for (let p = 0; p < projects; p++) {
    const project = await createTestProject(owner.id);
    await addProjectMember(project.id, owner.id, 'owner');
    ids.push(project.id);
    for (let i = 1; i <= 4; i++) {
      await createTestRequirement(project.id, i, `requirement ${i}`);
      const issue = await createTestIssue(project.id, owner.id, i, {
        status: i % 2 ? 'open' : 'in_progress',
        createdAt: new Date(Date.now() - i * 3_600_000),
      });
      await createTestFeedback(project.id, owner.id, i);
      if (i === 1) await askOwner(project.id, issue.id);
    }
  }
  return { token: await userToken(owner.id), ids };
}

describe('a read request asks its repeated lookups once', () => {
  let one: Awaited<ReturnType<typeof personWith>>;
  let three: Awaited<ReturnType<typeof personWith>>;

  beforeAll(async () => {
    // a question is asked through the queue, as a run asks it
    testEnv();
    await import('../../src/index.js');
    await startQueue();
    one = await personWith(1);
    three = await personWith(3);
  }, 180_000);

  afterAll(closeWorld);

  it(`spends at most ${PER_PROJECT_BOUND} statements per project on the cross-project needs-you read`, async () => {
    const a = await api(one.token, 'GET', '/api/me/attention');
    const b = await api(three.token, 'GET', '/api/me/attention');
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const perProject = (queriesOf(b.headers) - queriesOf(a.headers)) / 2;
    expect(
      perProject,
      `${queriesOf(a.headers)} at one project, ${queriesOf(b.headers)} at three`,
    ).toBeLessThanOrEqual(PER_PROJECT_BOUND);
  });

  // /attention holds each project's one Needs you (REQ-48 BC-11): the decisions its own needs-me read
  // answers, the same total and the first NEEDS_YOU_PERSON_CAP of them in the same order
  it('reads every project the same decisions across as the project read does on its own', async () => {
    const across = await api(three.token, 'GET', '/api/me/attention');
    const sections = across.body.needsYou as {
      projectSlug: string;
      total: number;
      decisions: { key: string }[];
    }[];
    expect(sections).toHaveLength(three.ids.length);
    const projects = (await api(three.token, 'GET', '/api/projects')).body as unknown as {
      id: string;
      slug: string;
    }[];
    for (const id of three.ids) {
      const slug = projects.find((p) => p.id === id)?.slug;
      expect(slug, `GET /api/projects lists ${id}`).toBeTruthy();
      const own = await api(three.token, 'GET', `/api/projects/${id}/needs-you/decisions`);
      expect(own.status).toBe(200);
      const ownDecisions = own.body.decisions as { key: string }[];
      const section = sections.find((p) => p.projectSlug === slug);
      expect(own.body.total).toBeGreaterThan(0);
      expect(section?.total, String(slug)).toBe(own.body.total);
      expect(section?.decisions.map((d) => d.key)).toEqual(
        ownDecisions.slice(0, NEEDS_YOU_PERSON_CAP).map((d) => d.key),
      );
    }
  });
});
