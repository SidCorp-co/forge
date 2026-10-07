// GET /projects/:id/needs-you read each design's health one workflow at a time (eight reads per
// design, and the run read model again for each design with builds), each storefront draft one
// workflow at a time, the design gate's reason once per withheld issue, and verified the session
// token once per router it passed. On HOP (dev, 30 designs, 124 issues) one request issued 919
// queries and answered in five seconds. Each input is now read once for the whole project: the
// same number of queries at three designs as at thirty, under a ceiling.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { closeWorld, type Doc, ok, requester, testEnv } from '../helpers/ecosystem-world.js';
import {
  createTestFeedback,
  createTestIssue,
  createTestProject,
  createTestRelease,
  createTestUser,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

/**
 * The most queries one needs-you request may issue, whatever the project holds: 156 on 2026-10-07,
 * when the same request at HOP's size issued 1257. A read added to any area moves it, on purpose.
 */
const QUERY_BOUND = 160;

interface Scale {
  designs: number;
  proposed: number;
  requirements: number;
  issues: number;
  released: number;
  feedback: number;
}

const SMALL: Scale = {
  designs: 3,
  proposed: 2,
  requirements: 3,
  issues: 8,
  released: 3,
  feedback: 3,
};
// HOP on dev (project d180bdca), 2026-10-07
const HOP: Scale = {
  designs: 30,
  proposed: 6,
  requirements: 32,
  issues: 124,
  released: 63,
  feedback: 20,
};

const OPEN_STATUSES = ['open', 'in_progress', 'needs_info', 'approved', 'reopen', 'on_hold'];

type Say = (method: string, path: string, body?: unknown) => Promise<{ status: number; json: Doc }>;

let ownerId: string;
let token: string;
let app: Awaited<typeof import('../../src/index.js')>['app'];

const design = (projectId: string, flow: string, summary: string): Doc => {
  const d: Doc = JSON.parse(
    readFileSync(
      new URL('../fixtures/workflows/post-discharge.design.json', import.meta.url),
      'utf8',
    ),
  );
  d.project = projectId;
  d.flow = flow;
  d.summary = summary;
  return d;
};

/** A project holding `n` of everything Needs you reads, each linked the way a working project links them. */
async function projectAt(n: Scale): Promise<string> {
  const projectId = (await createTestProject(ownerId)).id;
  const say: Say = (method, path, body) =>
    requester(app, { owner: token })('owner', method, `/api/projects/${projectId}${path}`, body);
  // a storefront project, so the issues' draft verdicts are read against the drafts it holds now
  await seedProjectDocument(projectId, ownerId, {
    environments: {},
    source: { type: 'storefront', storefront: { provider: 'autoflow', binding: randomUUID() } },
    extra: { workspace: { isolation: 'remote-draft' } },
  });

  const workflows: string[] = [];
  for (let i = 0; i < n.designs; i++) {
    const flow = `flow-${i}`;
    const made = ok(
      await say('POST', '/workflows', {
        baseRevision: null,
        document: design(projectId, flow, `revision one of ${flow}`),
      }),
      201,
    );
    const id = made.document.id as string;
    workflows.push(id);
    ok(await say('POST', `/workflows/${id}/design/propose`, { revision: 1 }));
    ok(await say('POST', `/workflows/${id}/design/decision`, { revision: 1, decision: 'approve' }));
    if (i < n.proposed) {
      // writing over an approved design proposes the new revision to its approver
      ok(
        await say('PUT', `/workflows/${id}`, {
          baseRevision: 1,
          document: { ...made.document, summary: `revision two of ${flow}` },
        }),
      );
    }
    await db.execute(sql`
      INSERT INTO suggestions (project_id, kind, fingerprint, producer_kind, workflow_id, payload, status)
      VALUES (${projectId}, 'design_change', ${`fp-${id}`}, 'agent', ${id},
              ${JSON.stringify({ steps: ['case'], change: 'change', reason: 'the case owner moved' })}::jsonb,
              'proposed')`);
    await db.execute(sql`
      INSERT INTO comments (author_id, body, workflow_id, intent, decision)
      VALUES (${ownerId}, 'keep it', ${id}, 'decision',
              ${JSON.stringify({ decision: 'keep', reason: 'still right', node: { step: 'call', verdict: 'keep' } })}::jsonb)`);
  }

  const criteria: { requirementId: string; criterionId: string; workflowId: string }[] = [];
  for (let r = 0; r < n.requirements; r++) {
    const workflowId = workflows[r % workflows.length] as string;
    const req = ok(
      await say('POST', '/requirements', {
        title: `requirement ${r + 1}`,
        reason: 'the case has to reach its owner',
        criteria: [{ body: 'The case reaches its owner.' }],
      }),
      201,
    ).key as string;
    ok(await say('POST', `/requirements/${req}/workflows`, { workflowId }));
    ok(
      await say('PUT', `/requirements/${req}/criteria/BC-1/steps`, {
        workflow: workflowId,
        steps: ['case'],
      }),
    );
    if (r % 2 === 0) {
      // half are agreed, half wait on their accept
      ok(await say('POST', `/requirements/${req}/revisions/1/propose`, {}));
      ok(await say('POST', `/requirements/${req}/revisions/1/accept`, { reason: 'ok' }));
    }
    const [c] = (await db.execute(sql`
      SELECT c.id AS criterion_id, c.requirement_id FROM requirement_criteria c
        JOIN requirements q ON q.id = c.requirement_id
       WHERE q.project_id = ${projectId} AND q.req_seq = ${Number(req.replace('REQ-', ''))}`)) as unknown as {
      criterion_id: string;
      requirement_id: string;
    }[];
    criteria.push({
      requirementId: c?.requirement_id as string,
      criterionId: c?.criterion_id as string,
      workflowId,
    });
  }

  const issues: string[] = [];
  const released: string[] = [];
  const at = new Date(Date.now() - 86_400_000);
  for (let i = 0; i < n.issues; i++) {
    const shipped = i < n.released;
    const crit = criteria[i % criteria.length];
    const status = shipped ? 'closed' : (OPEN_STATUSES[i % OPEN_STATUSES.length] as string);
    const issue = await createTestIssue(projectId, ownerId, i + 1, {
      status,
      ...(status === 'needs_info' ? { waitingKind: 'needs_decision' } : {}),
      createdAt: at,
      mergedAt: shipped ? at : null,
      requirementId: crit?.requirementId ?? null,
    });
    (shipped ? released : issues).push(issue.id);
    if (crit) {
      await db.execute(sql`
        INSERT INTO workflow_builds (issue_id, workflow_id, project_id, linked_by_user, step_ids)
        VALUES (${issue.id}, ${crit.workflowId}, ${projectId}, ${ownerId}, ARRAY['case'])`);
      const [ic] = (await db.execute(sql`
        INSERT INTO issue_criteria (issue_id, n, statement, position, requirement_criterion_id)
        VALUES (${issue.id}, 1, 'the case reaches its owner', 1, ${crit.criterionId}) RETURNING id`)) as unknown as {
        id: string;
      }[];
      await db.execute(sql`
        INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, author_agency, identity_kind,
                                        storefront_workflow_id, storefront_draft_version, reason)
        VALUES (${ic?.id}, ${issue.id}, ${i % 3 === 0 ? 'fail' : 'pass'}, 'agent', 'storefront_draft',
                ${`af-${i}`}, 'v1', 'judged on the draft')`);
    }
    await db.execute(sql`
      INSERT INTO pipeline_runs (project_id, issue_id, kind, status, started_at, finished_at, metadata)
      VALUES (${projectId}, ${issue.id}, 'issue', ${shipped ? 'completed' : 'running'},
              ${at.toISOString()}, ${shipped ? at.toISOString() : null}, '{}'::jsonb)`);
  }
  await createTestRelease(projectId, '1.0.0', released, at);

  for (let f = 0; f < n.feedback; f++) {
    await createTestFeedback(
      projectId,
      ownerId,
      f + 1,
      f % 2 === 0 ? [] : [issues[f % issues.length] as string],
    );
  }
  return projectId;
}

/** The queries one GET needs-you issues, and its answer. */
async function measured(projectId: string): Promise<{ queries: string[]; body: Doc }> {
  const client = (db as unknown as { $client: { options: { debug: unknown } } }).$client;
  const queries: string[] = [];
  client.options.debug = (_connection: number, query: string) => queries.push(query);
  try {
    const body = ok(
      await requester(app, { owner: token })(
        'owner',
        'GET',
        `/api/projects/${projectId}/needs-you`,
      ),
    );
    return { queries, body };
  } finally {
    client.options.debug = false;
  }
}

beforeAll(async () => {
  testEnv();
  ({ app } = await import('../../src/index.js'));
  // a design decision enqueues its events; no consumer works them, so no query runs beside the read
  await (await import('../../src/queue/boss.js')).startBoss();
  await (await import('../../src/outbox/index.js')).declareOutboxQueues();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  token = await signUserToken(ownerId);
}, 120_000);

afterAll(closeWorld);

describe('GET needs-you on a project the size of HOP', () => {
  it('issues the same bounded number of queries at three designs as at thirty', async () => {
    const small = await projectAt(SMALL);
    const large = await projectAt(HOP);
    await measured(large); // the first request pays for the prepared statements

    const few = await measured(small);
    const many = await measured(large);

    // every revision proposed waits on its approver, so the read reached each design
    expect(few.body.areas.designs.you).toBeGreaterThanOrEqual(SMALL.proposed);
    expect(many.body.areas.designs.you).toBeGreaterThanOrEqual(HOP.proposed);
    expect(
      many.queries.length,
      `${many.queries.length} queries at ${HOP.designs} designs, ${few.queries.length} at ${SMALL.designs}: a read issued once per row`,
    ).toBe(few.queries.length);
    expect(many.queries.length).toBeLessThanOrEqual(QUERY_BOUND);
  }, 180_000);
});
