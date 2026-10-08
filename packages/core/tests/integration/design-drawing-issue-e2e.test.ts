/**
 * The issue a design revision is drawn under, past the write that proposes it (ISS-261's fourth pass):
 * the re-pin act on ISS-387's HOP shape is an approval a person makes in one act, written with no
 * issue, so it is never refused as a proposal naming none, and a later proposal's walk passes over it;
 * propose re-names the issue a waiting revision is drawn under; the refusals read in short sentences
 * naming the flow; and a write that only records provenance proposes nothing (P6, ISS-376).
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  settleOutbox,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestProject, createTestUser, rows } from '../helpers/factories.js';

let projectId: string;
let ownerId: string;
let say: (who: 'owner' | 'master', method: string, path: string, body?: Doc) => Promise<Reply>;

const DEPENDENTS = [
  'operational-case',
  'complaint-intake',
  'complaint-ux',
  'campaign-ux',
  'evaluation-ux',
  'loyalty-ux',
] as const;
/** The dependents whose revision 1 was drawn under an issue that has since closed. */
const CLOSED = new Set(['operational-case', 'complaint-ux', 'loyalty-ux']);

const design = (flow: string, basedOn?: Doc[]): Doc => {
  const d = JSON.parse(
    readFileSync(
      new URL('../fixtures/workflows/post-discharge.design.json', import.meta.url),
      'utf8',
    ),
  );
  d.project = projectId;
  d.flow = flow;
  if (basedOn) d.basedOn = basedOn;
  return d;
};

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const { mintPat } = await import('../../src/credentials/pat.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  const agentId = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, agentId, 'member');
  say = requester(app, {
    owner: await signUserToken(ownerId),
    master: (
      await mintPat({
        permissions: ['*'],
        userId: agentId,
        name: 'master',
        projectIds: [projectId],
      })
    ).plaintext,
  });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await settleOutbox();
});

const at = (path: string) => `/api/projects/${projectId}${path}`;
const codesOf = (r: Reply) => (r.json.error?.refusals ?? []).map((x: Doc) => x.code);
/** The longest sentence of a refusal's detail, in words: the one-sentence form ran to about 80. */
const longestSentence = (detail: string) =>
  Math.max(...detail.split(/(?<=\.)\s+(?=[A-Z])/).map((s) => s.split(/\s+/).length));
const ids = new Map<string, string>();

let seq = 700;
async function plantIssue(status: string): Promise<{ id: string; key: string }> {
  const id = randomUUID();
  seq += 1;
  const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
  await withKernelMarker(db, (tx) =>
    tx.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${id}, ${projectId}, ${seq}, ${`planted ${status}`}, ${status}, ${ownerId})
    `),
  );
  return { id, key: `ISS-${seq}` };
}

async function closeIssue(id: string): Promise<void> {
  const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
  await withKernelMarker(db, (tx) =>
    tx.execute(sql`UPDATE issues SET status = 'closed', merged_at = now() WHERE id = ${id}`),
  );
}

const propose = (flow: string, revision: number, issue?: string) =>
  say('master', 'POST', at(`/workflows/${ids.get(flow)}/design/propose`), {
    revision,
    ...(issue ? { issue } : {}),
  });

const decide = (flow: string, revision: number, decision: string, reason?: string) =>
  say('owner', 'POST', at(`/workflows/${ids.get(flow)}/design/decision`), {
    revision,
    decision,
    ...(reason === undefined ? {} : { reason }),
  });

async function proposedAt1(flow: string, basedOn?: Doc[], issue?: string): Promise<string> {
  const made = ok(
    await say('master', 'POST', at('/workflows'), {
      baseRevision: null,
      document: design(flow, basedOn),
    }),
    201,
  );
  const id = made.document.id as string;
  ids.set(flow, id);
  ok(await propose(flow, 1, issue));
  return id;
}

async function approvedAt1(flow: string, basedOn?: Doc[], issue?: string): Promise<string> {
  const id = await proposedAt1(flow, basedOn, issue);
  ok(await decide(flow, 1, 'approve'));
  return id;
}

const read = async (flow: string) =>
  ok(await say('owner', 'GET', at(`/workflows/${ids.get(flow)}/design`)));

const notesOn = async (issueId: string) =>
  (await rows<{ body: string }>(sql`SELECT body FROM comments WHERE issue_id = ${issueId}`))
    .map((c) => c.body)
    .join('\n');

/** A PUT changing the design as the master's next proposal would, naming `issue` where given. */
async function rewrite(flow: string, edit: (d: Doc) => void, issue?: string): Promise<Reply> {
  const current = ok(await say('master', 'GET', at(`/workflows/${ids.get(flow)}`)));
  const { id, createdAt, updatedAt, ...doc } = current.document;
  void createdAt;
  void updatedAt;
  edit(doc);
  return say('master', 'PUT', at(`/workflows/${id}`), {
    baseRevision: current.revision,
    document: doc,
    ...(issue ? { issue } : {}),
  });
}

const summaryEdit = (note: string) => (d: Doc) => {
  d.summary = `${d.summary} (${note})`;
};

describe('the re-pin act and the issue a revision is drawn under', () => {
  it('is never refused for its issue-less revisions, and a later proposal walks past them', async () => {
    const issueOf = new Map<string, { id: string; key: string }>();
    await approvedAt1('access');
    const onAccess = [{ workflow: 'access', revision: 1 }];
    for (const flow of DEPENDENTS) {
      const issue = await plantIssue('in_progress');
      issueOf.set(flow, issue);
      await approvedAt1(
        flow,
        flow === 'complaint-ux'
          ? [...onAccess, { workflow: 'complaint-intake', revision: 1 }]
          : onAccess,
        issue.key,
      );
    }
    for (const flow of CLOSED) await closeIssue(issueOf.get(flow)?.id as string);

    const revised = (d: Doc) => {
      d.steps[0].node.label = 'Hospital HIS (revised)';
    };
    ok(await rewrite('access', revised, (await plantIssue('open')).key));
    ok(await decide('access', 2, 'approve'));

    const plan = ok(await say('owner', 'GET', at(`/workflows/${ids.get('access')}/design/repins`)));
    expect(plan.refused).toEqual([]);
    const done = await say('owner', 'POST', at(`/workflows/${ids.get('access')}/design/repins`), {
      revision: 2,
      designs: plan.ready.map((r: Doc) => ({ workflowId: r.workflowId, revision: r.revision })),
    });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(done.json.approved).toHaveLength(6);

    for (const flow of DEPENDENTS) {
      const d = await read(flow);
      expect(d.status, flow).toBe('approved');
      expect(
        d.revisions.map((r: Doc) => r.designIssueId),
        flow,
      ).toEqual([null, issueOf.get(flow)?.id]);
      expect(d.revisions[0].says?.reason?.key, flow).toBe('designs.reason.repinOnly');
    }

    for (const flow of DEPENDENTS) {
      const before = await read(flow);
      const res = await rewrite(flow, summaryEdit('after the re-pin'));
      const issue = issueOf.get(flow) as { id: string; key: string };
      if (CLOSED.has(flow)) {
        expect(res.status, `${flow}: ${JSON.stringify(res.json)}`).toBe(422);
        const [refusal] = res.json.error.refusals;
        expect(refusal).toMatchObject({ code: 'WORKFLOW_DESIGN_ISSUE_REQUIRED', path: '/issue' });
        expect(refusal.detail, flow).toContain(
          `Revision 2, the one it supersedes, is a re-pin, which names no issue. Revision 1 is the latest that named one, and it was drawn under ${issue.key}, which is closed.`,
        );
        expect(longestSentence(refusal.detail), flow).toBeLessThanOrEqual(25);
        const after = await read(flow);
        expect(after.revision, flow).toBe(before.revision);
        expect(after.revisions, flow).toHaveLength(2);
      } else {
        expect(res.status, `${flow}: ${JSON.stringify(res.json)}`).toBe(200);
        const after = await read(flow);
        expect(after.status, flow).toBe('proposed');
        expect(after.revisions[0], flow).toMatchObject({ revision: 3, designIssueId: issue.id });
      }
    }
  });
});

describe('the lapsed refusal on FB-54 shape reads in short sentences', () => {
  it('names the revisions in sentences of at most 25 words, and writes nothing', async () => {
    const closed = await plantIssue('in_progress');
    await approvedAt1('fb54-flow', undefined, closed.key);
    ok(await rewrite('fb54-flow', summaryEdit('rev 2'), (await plantIssue('open')).key));
    // FB-54's patient-data-flow rev 8: the old code stored a revision with no issue
    await db.execute(sql`
      UPDATE project_workflow_designs SET design_issue_id = NULL
       WHERE workflow_id = ${ids.get('fb54-flow')} AND revision = 2
    `);
    ok(await decide('fb54-flow', 2, 'approve'));
    await closeIssue(closed.id);

    const res = await rewrite('fb54-flow', summaryEdit('rev 3'));
    expect(codesOf(res)).toEqual(['WORKFLOW_DESIGN_ISSUE_REQUIRED']);
    const [refusal] = res.json.error.refusals;
    expect(refusal.detail).toContain(
      `Revision 2, the one it supersedes, names no issue. Revision 1 is the latest that named one, and it was drawn under ${closed.key}, which is closed.`,
    );
    expect(refusal.detail).toContain("workflow fb54-flow's design");
    expect(refusal.detail).toContain('Nothing was written.');
    expect(longestSentence(refusal.detail)).toBeLessThanOrEqual(25);
    expect((await read('fb54-flow')).revisions).toHaveLength(2);
  });
});

describe('propose re-names the issue a waiting revision is drawn under', () => {
  it('re-points the waiting revision, writes no new one, tells the issue that lost it, and a return reaches the new one', async () => {
    const inheritedFrom = await plantIssue('in_progress');
    await approvedAt1('redrawn-flow', undefined, inheritedFrom.key);
    ok(await rewrite('redrawn-flow', summaryEdit('rev 2')));
    const before = await read('redrawn-flow');
    expect(before.revisions[0]).toMatchObject({ revision: 2, designIssueId: inheritedFrom.id });

    const drawing = await plantIssue('open');
    const redrawn = ok(await propose('redrawn-flow', before.revision, drawing.key));
    expect(redrawn.status).toBe('proposed');
    expect(redrawn.revision).toBe(before.revision);
    expect(redrawn.proposedRevision).toBe(2);
    expect(redrawn.revisions.map((r: Doc) => [r.revision, r.designIssueId])).toEqual([
      [2, drawing.id],
      [1, inheritedFrom.id],
    ]);
    expect(await notesOn(inheritedFrom.id)).toContain(
      `Design \`redrawn-flow\` revision 2, waiting on its approver, is now drawn under ${drawing.key}`,
    );

    const returned = ok(await decide('redrawn-flow', 2, 'return', 'draw the consent owner'));
    expect(returned.designIssue).toMatchObject({ issueId: drawing.id });
    expect(await notesOn(drawing.id)).toContain('draw the consent owner');
    expect(await notesOn(inheritedFrom.id)).not.toContain('draw the consent owner');
  });

  it('still refuses a propose naming no issue on a proposed design, by flow, saying how to re-name', async () => {
    const id = await proposedAt1('waiting-flow');
    const res = await propose('waiting-flow', 1);
    expect(res.status, JSON.stringify(res.json)).toBe(422);
    expect(codesOf(res)).toEqual(['WORKFLOW_DESIGN_ALREADY_PROPOSED']);
    const [refusal] = res.json.error.refusals;
    expect(refusal.detail).toContain('workflow waiting-flow is already awaiting its approver');
    expect(refusal.detail).toContain('propose again with `issue`');
    expect(refusal.detail).not.toContain(id);
  });

  it('refuses re-naming a waiting revision to the issue that builds the workflow', async () => {
    const id = await proposedAt1('redraw-build-flow');
    const build = await plantIssue('open');
    ok(await say('master', 'POST', at(`/workflows/${id}/builds`), { issue: build.key }));
    const res = await propose('redraw-build-flow', 1, build.key);
    expect(codesOf(res)).toEqual(['WORKFLOW_DESIGN_ISSUE_IS_BUILD']);
    expect((await read('redraw-build-flow')).revisions[0].designIssueId).toBe(null);
  });
});

describe('a propose refused at a design status names the workflow by its flow', () => {
  it('names the flow, never the uuid, on an approved and on a returned design', async () => {
    const approved = await approvedAt1('named-approved-flow');
    const returned = await proposedAt1('named-returned-flow');
    ok(await decide('named-returned-flow', 1, 'return', 'draw the hand-off'));
    for (const [id, flow, code] of [
      [approved, 'named-approved-flow', 'WORKFLOW_DESIGN_ALREADY_APPROVED'],
      [returned, 'named-returned-flow', 'WORKFLOW_DESIGN_UNCHANGED'],
    ] as const) {
      const res = await propose(flow, 1);
      expect(codesOf(res)).toEqual([code]);
      const [refusal] = res.json.error.refusals;
      expect(refusal.detail).toContain(`workflow ${flow}'s design`);
      expect(refusal.detail).not.toContain(id);
    }
  });
});

describe('a write that only records provenance (P6, answered by ISS-376)', () => {
  it('proposes nothing, so a closed issue behind the design refuses nothing', async () => {
    const closed = await plantIssue('in_progress');
    await approvedAt1('provenance-only-flow', undefined, closed.key);
    await closeIssue(closed.id);
    for (const sha of ['a'.repeat(40), 'b'.repeat(40)]) {
      ok(
        await rewrite('provenance-only-flow', (d) => {
          d.writtenBy = { sha };
        }),
      );
      const after = await read('provenance-only-flow');
      expect(after.status).toBe('approved');
      expect(after.revisions).toHaveLength(1);
    }
  });
});
