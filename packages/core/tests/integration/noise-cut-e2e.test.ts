/**
 * REQ-41 BC-10, BC-11, BC-12 (docs/proposals/chat-first.md, "Noise cut at the source"): three rows
 * that waited on a person and need nobody. A design approval no traced step of a requirement's
 * criteria failed to survive is followed by the kernel; one that removed a traced step waits on the
 * assistant, never on a person. An issue that spent its run sessions parks for its master. A draft
 * nobody touched for a week gets one merge-or-drop question with a recommended answer; a younger
 * draft gets none.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { RUN_ISSUES_METADATA_KEY } from '@forge/contracts/agent-sessions';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import {
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
} from '../helpers/factories.js';

let say: (who: 'owner', method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let ownerId = '';
const at = (path: string) => `/api/projects/${projectId}${path}`;
const as = (method: string, path: string, body?: unknown) => say('owner', method, at(path), body);

const fixture = (): Doc =>
  JSON.parse(
    readFileSync(
      new URL('../fixtures/workflows/post-discharge.design.json', import.meta.url),
      'utf8',
    ),
  );

/** A workflow `flow` approved at revision 1. */
async function approvedDesign(flow: string): Promise<{ id: string; document: Doc }> {
  const document = fixture();
  document.project = projectId;
  document.flow = flow;
  const made = ok(await as('POST', '/workflows', { baseRevision: null, document }), 201)
    .document as Doc;
  ok(await as('POST', `/workflows/${made.id}/design/propose`, { revision: 1 }));
  ok(
    await as('POST', `/workflows/${made.id}/design/decision`, { revision: 1, decision: 'approve' }),
  );
  return { id: made.id as string, document: made };
}

/** A requirement agreed at r1 against `workflowId`, its BC-1 tracing `step`. */
async function agreedTracing(workflowId: string, step: string): Promise<string> {
  const key = ok(
    await as('POST', '/requirements', {
      title: `The coordinator reaches the patient (${step})`,
      reason: 'a discharged patient is called back',
      criteria: [{ body: 'A discharged patient who needs follow-up is called.' }],
    }),
    201,
  ).key as string;
  ok(await as('POST', `/requirements/${key}/workflows`, { workflowId }));
  ok(
    await as('PUT', `/requirements/${key}/criteria/BC-1/steps`, {
      workflow: workflowId,
      steps: [step],
    }),
  );
  ok(await as('POST', `/requirements/${key}/revisions/1/propose`, {}));
  ok(await as('POST', `/requirements/${key}/revisions/1/accept`, { reason: 'ok' }));
  ok(await as('POST', `/requirements/${key}/agree`, { revision: 1, reason: 'ok' }));
  return key;
}

/** Writes revision 2 of the design as `change` makes it, approves it, and lets the outbox work. */
async function approveRevision2(design: { id: string; document: Doc }, change: (d: Doc) => void) {
  const next = structuredClone(design.document);
  change(next);
  ok(await as('PUT', `/workflows/${design.id}`, { baseRevision: 1, document: next }));
  ok(
    await as('POST', `/workflows/${design.id}/design/decision`, {
      revision: 2,
      decision: 'approve',
    }),
  );
  await settleOutbox();
}

const baselines = (key: string) =>
  rows<{ seq: number; act: string; reason: string | null }>(sql`
    SELECT b.seq, b.act, b.reason FROM requirement_baselines b
      JOIN requirements r ON r.id = b.requirement_id
     WHERE r.project_id = ${projectId} AND r.req_seq = ${Number(key.slice(4))}
     ORDER BY b.seq`);

const standingOf = async (key: string) =>
  ok(await as('GET', `/requirements/${key}`)).standing as Doc;

const needsYouKeys = async (): Promise<string[]> => {
  const read = ok(await as('GET', '/needs-you'));
  return (read.items as Doc[]).map((r) => String(r.key));
};

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  say = requester(app, { owner: await signUserToken(ownerId) });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('BC-10: a requirement follows an approved design by itself when its criteria do not change', () => {
  it('is re-pinned by the kernel when the new revision keeps every step its criteria trace', async () => {
    const design = await approvedDesign('follows-flow');
    const key = await agreedTracing(design.id, 'case');
    await approveRevision2(design, (d) => {
      d.steps[0].node.label = 'Hospital HIS (renamed, untraced)';
    });

    const pins = await baselines(key);
    expect(pins.map((b) => [b.seq, b.act])).toEqual([
      [1, 'agree'],
      [2, 'repin'],
    ]);
    expect(pins[1]?.reason).toContain(
      'Followed by itself on the design approval: follows-flow r1 → r2',
    );
    const s = await standingOf(key);
    expect((s.facts as Doc).stalePins).toEqual([]);
    expect(s.attentionGroup).not.toBe('needs_you');
    expect(String((s.waitingOn as Doc).act)).not.toContain('Update to the approved design');
    expect(await needsYouKeys()).not.toContain(key);
  });

  it('is followed by the timer where the approval found it not agreed, so no row stays stale', async () => {
    const design = await approvedDesign('deferred-flow');
    const key = await agreedTracing(design.id, 'case');
    ok(await as('POST', `/requirements/${key}/defer`, { reason: 'next release' }));
    await approveRevision2(design, (d) => {
      d.summary = 'revision two, same steps';
    });
    ok(await as('POST', `/requirements/${key}/undefer`, { reason: 'back in this release' }));
    expect(
      (await baselines(key)).map((b) => b.act),
      'a deferred requirement follows nothing',
    ).toEqual(['agree']);
    expect(((await standingOf(key)).waitingOn as Doc).act).toBe(
      'Update to the approved design: Post-discharge follow-up (revision 2)',
    );

    const { followApprovedDesigns } = await import('../../src/requirements/auto-follow.js');
    expect((await followApprovedDesigns()).followed).toBe(1);
    expect((await baselines(key)).map((b) => b.act)).toEqual(['agree', 'repin']);
    expect((await followApprovedDesigns()).followed, 'a followed row is not followed twice').toBe(
      0,
    );
  });

  it('is not re-pinned when the new revision removes a traced step, and waits on the assistant, not a person', async () => {
    const design = await approvedDesign('removes-flow');
    const key = await agreedTracing(design.id, 'context');
    await approveRevision2(design, (d) => {
      d.steps = (d.steps as Doc[]).filter((s) => s.id !== 'context');
      for (const s of d.steps as Doc[])
        s.after = (s.after as string[]).filter((a) => a !== 'context');
      d.edges = (d.edges as Doc[])
        .filter((e) => e.from !== 'context')
        .map((e) => (e.to === 'context' ? { ...e, to: 'followup-rule' } : e));
    });

    expect((await baselines(key)).map((b) => b.act)).toEqual(['agree']);
    const s = await standingOf(key);
    expect(s.attentionGroup).toBe('waiting');
    expect(s.waitingOn).toMatchObject({
      kind: 'agent',
      who: 'Master',
      act: 'revise BC-1 for Post-discharge follow-up (revision 2): context removed',
    });
    expect(await needsYouKeys()).not.toContain(key);
  });
});

describe('BC-11: a run parked after repeated failures waits on the master, never on a person', () => {
  it('parks at on_hold with no question, and its standing waits on the master', async () => {
    const seq = 901;
    const issue = await createTestIssue(projectId, ownerId, seq, {
      status: 'open',
      createdAt: new Date(Date.now() - 3_600_000),
    });
    const device = await createTestDevice(ownerId);
    for (let n = 0; n < 3; n++) {
      const runId = randomUUID();
      await db.execute(sql`
        INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, finished_at, metadata)
        VALUES (${runId}, ${projectId}, 'system', 'completed', now(), now(),
                ${JSON.stringify({ [RUN_ISSUES_METADATA_KEY]: [issue.key] })}::jsonb)`);
      await db.execute(sql`
        INSERT INTO agent_sessions (project_id, device_id, pipeline_run_id, kind, status, started_at, created_at)
        VALUES (${projectId}, ${device}, ${runId}, 'run_session', 'completed', now(), now())`);
    }
    const { checkAutonomousRescueCap } = await import(
      '../../src/pipeline/autonomous-rescue-cap.js'
    );
    expect(
      await checkAutonomousRescueCap({
        projectId,
        issueId: issue.id,
        status: 'open',
        reopenCount: 0,
      }),
    ).toEqual({ capped: true });

    const [row] = await rows<{ status: string; waiting_kind: string | null }>(
      sql`SELECT status, waiting_kind FROM issues WHERE id = ${issue.id}`,
    );
    expect(row).toEqual({ status: 'on_hold', waiting_kind: null });
    expect(
      await rows(sql`SELECT id FROM agent_questions WHERE issue_id = ${issue.id}`),
      'the cap asks no person a question',
    ).toEqual([]);
    const standing = ok(await as('GET', `/issues/standing/${issue.key}`)) as Doc;
    expect((standing.standing ?? standing).waitingOn).toMatchObject({
      kind: 'master',
      who: 'Master',
    });
  });
});

describe('BC-12: a draft untouched for 7 days gets one merge-or-drop question from the assistant', () => {
  const DAY = 86_400_000;
  let old = '';
  let young = '';
  let oldIssue = { id: '', key: '' };

  const backdate = async (key: string, days: number) => {
    const when = new Date(Date.now() - days * DAY).toISOString();
    const seq = Number(key.slice(4));
    await db.execute(sql`
      UPDATE requirement_revisions SET created_at = ${when}
       WHERE requirement_id = (SELECT id FROM requirements WHERE project_id = ${projectId} AND req_seq = ${seq})`);
    await db.execute(sql`
      UPDATE requirements SET updated_at = ${when} WHERE project_id = ${projectId} AND req_seq = ${seq}`);
  };

  const questionsOn = (on: { requirement?: string; issueId?: string }) =>
    rows<{ status: string; steps: Doc[] }>(
      on.issueId
        ? sql`SELECT status, steps FROM agent_questions WHERE issue_id = ${on.issueId}`
        : sql`SELECT q.status, q.steps FROM agent_questions q JOIN requirements r ON r.id = q.requirement_id
               WHERE r.project_id = ${projectId} AND r.req_seq = ${Number(on.requirement?.slice(4))}`,
    );

  beforeAll(async () => {
    const draft = async (title: string) =>
      ok(
        await as('POST', '/requirements', {
          title,
          reason: 'someone asked once',
          criteria: [{ body: 'The list exports to a spreadsheet.' }],
        }),
        201,
      ).key as string;
    old = await draft('Export the call list');
    young = await draft('Print the call list');
    await backdate(old, 8);
    await backdate(young, 6);
    oldIssue = await createTestIssue(projectId, ownerId, 902, {
      status: 'draft',
      createdAt: new Date(Date.now() - 9 * DAY),
    });
    await db.execute(
      sql`UPDATE issues SET updated_at = ${new Date(Date.now() - 9 * DAY).toISOString()} WHERE id = ${oldIssue.id}`,
    );
  });

  it('asks one question with three options and a recommended one on an 8-day-old draft, and none on a 6-day-old one', async () => {
    const { sweepStaleDrafts } = await import('../../src/requirements/stale-drafts.js');
    const first = await sweepStaleDrafts();
    expect(first.refused).toBe(0);

    const [q, ...more] = await questionsOn({ requirement: old });
    expect(more).toEqual([]);
    expect(q?.status).toBe('open');
    const step = q?.steps[0] as Doc;
    expect((step.options as Doc[]).map((o) => o.id)).toEqual([
      'stale_draft.merge',
      'stale_draft.drop',
      'stale_draft.keep',
    ]);
    expect(step.recommendedOptionId).toBe('stale_draft.drop');
    expect(String(step.prompt)).toContain(`${old} "Export the call list" is a draft requirement`);
    expect(String(step.prompt)).toContain(
      'Recommended: Drop it, because nobody touched it for 8 days',
    );
    expect(await questionsOn({ requirement: young })).toEqual([]);
    expect(await questionsOn({ issueId: oldIssue.id })).toHaveLength(1);

    const s = await standingOf(old);
    expect(s.waitingOn).toMatchObject({
      kind: 'you',
      act: 'answer whether to merge, drop or keep this draft',
    });
  });

  it('asks once: a second pass and a pass after a keep write nothing more', async () => {
    const { sweepStaleDrafts } = await import('../../src/requirements/stale-drafts.js');
    expect(await sweepStaleDrafts()).toEqual({ asked: 0, refused: 0 });
    const [asked] = await rows<{ id: string }>(
      sql`SELECT id FROM agent_questions WHERE issue_id = ${oldIssue.id}`,
    );
    ok(
      await say('owner', 'POST', `/api/questions/${asked?.id}/answer`, {
        round: 1,
        optionId: 'stale_draft.keep',
      }),
    );
    expect(await sweepStaleDrafts()).toEqual({ asked: 0, refused: 0 });
    const after = await questionsOn({ issueId: oldIssue.id });
    expect(after.map((q) => q.status)).toEqual(['answered']);
  });
});
