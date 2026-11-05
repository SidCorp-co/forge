// ISS-984 criterion 2 (owner, 2026-11-05): the product lane and the technical lane are taught, never
// enforced. Core adds no refusal: an agent's technical finding, filed with no requirement and no
// Feedback behind it, is accepted under every gate profile, carrying the kind, module and where-found
// the `what-is-an-issue` guide's "Filing a technical item today" names, and the project's issue list
// reads it back by module and kind.
//
// @direct-test-of packages/core/src/issues/create-service.ts
// @direct-test-of packages/core/src/guides/issue-guides.ts

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { api, patToken, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';
import { declareControls } from '../helpers/project-controls.js';

let projectId: string;
let ownerId: string;
let owner: string;
let agent: string;
let blockerId: string;

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, ownerId, 'admin');
  owner = await userToken(ownerId);
  const bot = await createTestUser({ kind: 'agent' });
  await addProjectMember(projectId, bot.id, 'member');
  agent = await patToken(bot.id, [projectId]);

  const module = await api(owner, 'POST', `/api/projects/${projectId}/labels`, {
    name: 'Orders',
    kind: 'module',
  });
  expect(module.status, JSON.stringify(module.body)).toBe(201);
  const worked = await api(agent, 'POST', `/api/projects/${projectId}/issues`, {
    title: 'The issue the agent was building',
  });
  expect(worked.status, JSON.stringify(worked.body)).toBe(201);
  blockerId = (worked.body as { id: string }).id;
});

/** The body the guide teaches: kind as category, module as primary label, where found first. */
const technicalItem = (kind: string) => ({
  title: 'The order list filters on a column no index covers',
  status: 'draft',
  description:
    'Found in: the issue the agent was building — `EXPLAIN` on the order list shows a sequential scan over 2.1M rows.\n\n> The order list takes 4 s to load once a shop passes a million orders.',
  category: kind,
  labels: [{ labelId: 'Orders', isPrimary: true }],
  relations: [{ kind: 'relates', dependsOnId: blockerId }],
});

describe('an agent files a technical finding with no requirement and no Feedback behind it', () => {
  it.each(['standard', 'strict', 'yolo'] as const)(
    'is accepted under %s, born at draft with its kind, its module and where it was found',
    async (profile) => {
      await declareControls(projectId, ownerId, { gates: { profile } });

      const res = await api(
        agent,
        'POST',
        `/api/projects/${projectId}/issues`,
        technicalItem('performance'),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const id = (res.body as { id: string }).id;

      const [row] = await rows<{
        status: string;
        category: string;
        requirement_id: string | null;
        feedback: number;
        module: string | null;
        primary: boolean | null;
        relates: number;
      }>(sql`
        SELECT i.status, i.category, i.requirement_id,
               (SELECT count(*)::int FROM feedback_route_issues f WHERE f.issue_id = i.id) AS feedback,
               (SELECT l.name FROM issue_labels il JOIN labels l ON l.id = il.label_id
                 WHERE il.issue_id = i.id AND l.kind = 'module') AS module,
               (SELECT il.is_primary FROM issue_labels il WHERE il.issue_id = i.id) AS primary,
               (SELECT count(*)::int FROM issue_dependencies d
                 WHERE d.kind = 'relates' AND (d.from_issue_id = i.id OR d.to_issue_id = i.id)) AS relates
          FROM issues i WHERE i.id = ${id}
      `);
      expect(row).toEqual({
        status: 'draft',
        category: 'performance',
        requirement_id: null,
        feedback: 0,
        module: 'Orders',
        primary: true,
        relates: 1,
      });
    },
  );

  it('takes each of the five kinds the guide names, and the list reads them back by module and kind', async () => {
    const kinds = ['bug', 'security', 'performance', 'debt', 'contract'];
    for (const kind of kinds) {
      const res = await api(
        agent,
        'POST',
        `/api/projects/${projectId}/issues`,
        technicalItem(kind),
      );
      expect(res.status, `${kind}: ${JSON.stringify(res.body)}`).toBe(201);
    }

    const all = await api(owner, 'GET', `/api/projects/${projectId}/issues?module=Orders&limit=50`);
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    const listed = (all.body as { items: { category: string }[] }).items.map((r) => r.category);
    expect(listed.sort()).toEqual([...kinds].sort());
    // the issue the agent was building carries no module, so the module read leaves it out

    const debt = await api(
      owner,
      'GET',
      `/api/projects/${projectId}/issues?module=Orders&category=debt&limit=50`,
    );
    expect((debt.body as { items: unknown[] }).items).toHaveLength(1);
  });
});

it('the guide that teaches the filing, served, names the body this test files', async () => {
  const res = await api(null, 'GET', '/api/guides/what-is-an-issue.md');
  expect(res.status).toBe(200);
  const body = String(res.body.text);
  for (const field of [
    '`"status": "draft"`',
    '`category`',
    '"isPrimary": true',
    'Found in:',
    '"kind": "relates"',
  ]) {
    expect(body).toContain(field);
  }
});
