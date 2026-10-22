/**
 * REQ-41 BC-10, BC-11 (docs/proposals/chat-first.md, "Noise cut at the source"). A design
 * approval no traced step of a requirement's criteria failed to survive makes a re-pin due and moves
 * no pin: its mover re-pins it through the requirement's own re-pin act (nothing re-pins by itself,
 * the owner's ruling of 2026-10-14); one that removed a traced step waits on the assistant, never on
 * a person. An issue that spent its run sessions parks for its master. A stuck draft's question is
 * the steward's (REQ-48 BC-5): `steward-draft-decisions-e2e.test.ts`.
 */

// @direct-test-of packages/core/src/lib/standing-times.ts

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
  bindTestRunner,
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestUser,
  makeAgreeReady,
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
  await makeAgreeReady(projectId, Number(key.slice(4)), ownerId);
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
  // a runner is online, so the master these waits name can act (FB-77)
  await bindTestRunner(projectId, await createTestDevice(ownerId));
  say = requester(app, { owner: await signUserToken(ownerId) });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('BC-10: a requirement follows an approved design when its mover re-pins it, never by itself', () => {
  it('moves no pin on the approval, waits on a re-pin, and follows once the signer re-pins it', async () => {
    const design = await approvedDesign('follows-flow');
    const key = await agreedTracing(design.id, 'case');
    await approveRevision2(design, (d) => {
      d.steps[0].node.label = 'Hospital HIS (renamed, untraced)';
    });

    expect(
      (await baselines(key)).map((b) => b.act),
      'REQ-41 BC-10: nothing re-pins a requirement by itself on a design approval',
    ).toEqual(['agree']);
    const waiting = await standingOf(key);
    expect((waiting.facts as Doc).stalePins).toHaveLength(1);
    expect(waiting.attentionGroup).toBe('needs_you');
    expect((waiting.waitingOn as Doc).act).toBe(
      'Update to the approved design: Post-discharge follow-up (revision 2)',
    );
    expect(await needsYouKeys()).toContain(key);

    ok(
      await as('POST', `/requirements/${key}/repin`, {
        revision: 1,
        reason: 'follows-flow r2 renamed an untraced step',
      }),
    );
    const pins = await baselines(key);
    expect(pins.map((b) => [b.seq, b.act])).toEqual([
      [1, 'agree'],
      [2, 'repin'],
    ]);
    const [kind] = await rows<{ agreed_kind: string; agreed_by: string | null }>(sql`
      SELECT b.agreed_kind, b.agreed_by FROM requirement_baselines b JOIN requirements r ON r.id = b.requirement_id
       WHERE r.project_id = ${projectId} AND r.req_seq = ${Number(key.slice(4))} AND b.act = 'repin'`);
    expect(kind, "the re-pin is the signer's own act").toEqual({
      agreed_kind: 'person',
      agreed_by: ownerId,
    });
    const s = await standingOf(key);
    expect((s.facts as Doc).stalePins).toEqual([]);
    expect(await needsYouKeys()).not.toContain(key);
  });

  it('leaves a requirement deferred across the approval pinned behind once it is back, for its mover', async () => {
    const design = await approvedDesign('deferred-flow');
    const key = await agreedTracing(design.id, 'case');
    ok(await as('POST', `/requirements/${key}/defer`, { reason: 'next release' }));
    await approveRevision2(design, (d) => {
      d.summary = 'revision two, same steps';
    });
    ok(await as('POST', `/requirements/${key}/undefer`, { reason: 'back in this release' }));
    expect((await baselines(key)).map((b) => b.act)).toEqual(['agree']);
    expect(((await standingOf(key)).waitingOn as Doc).act).toBe(
      'Update to the approved design: Post-discharge follow-up (revision 2)',
    );
    ok(await as('POST', `/requirements/${key}/repin`, { revision: 1, reason: 'same steps' }));
    expect((await baselines(key)).map((b) => b.act)).toEqual(['agree', 'repin']);
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
    // a wait on the master where none serves this project reads stuck (REQ-48 BC-9 nobody_serves)
    expect(s.attentionGroup).toBe('stuck');
    expect((s.times as Doc).stuck).toMatchObject({ code: 'nobody_serves' });
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
