/**
 * Nothing moves by itself, beyond requirements too (the owner's ruling of 2026-10-14, forge-core-eb):
 * every outbox consumer core registers works every delivery the setup emits, and every cluster timer
 * core runs is run, and still no requirement is re-pinned on a design approval (REQ-41 BC-10), no
 * pin-only design revision approves itself (REQ-41 BC-23), no resolved feedback item is verified
 * though its record reads the problem gone (Feedback triage r16), and no draft issue whose ready
 * checklist is complete opens (Issue lifecycle r15). Each waits on the door a person or an agent
 * takes. Against real Postgres, the queue started as the server starts it.
 *
 * @direct-test-of packages/core/src/timer-registry.ts
 * @direct-test-of packages/core/src/outbox-consumers.ts
 */

import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreTimers } from '../../src/timer-registry.js';
import { userToken } from '../helpers/api.js';
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
  createReadyDraftIssue,
  createTestProject,
  createTestUser,
  makeAgreeReady,
  rows,
} from '../helpers/factories.js';
import { vouchedByPassingCriterion } from '../helpers/loop-close.js';
import { TRIAGE_ANSWERS } from '../helpers/triage-answers.js';

let say: (who: 'owner', method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let ownerId = '';
const at = (path: string) => `/api/projects/${projectId}${path}`;
const as = (method: string, path: string, body?: unknown) => say('owner', method, at(path), body);
const ids = new Map<string, string>();
const onTeardown: (() => void)[] = [];

const fixture = (flow: string, basedOn?: Doc[]): Doc => {
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

async function approvedAt1(flow: string, basedOn?: Doc[]): Promise<string> {
  const made = ok(
    await as('POST', '/workflows', { baseRevision: null, document: fixture(flow, basedOn) }),
    201,
  ).document as Doc;
  const id = made.id as string;
  ids.set(flow, id);
  ok(await as('POST', `/workflows/${id}/design/propose`, { revision: 1 }));
  ok(await as('POST', `/workflows/${id}/design/decision`, { revision: 1, decision: 'approve' }));
  return id;
}

async function rewrite(flow: string, edit: (d: Doc) => void): Promise<void> {
  const current = ok(await as('GET', `/workflows/${ids.get(flow)}`));
  const { id, createdAt, updatedAt, ...doc } = current.document;
  void createdAt;
  void updatedAt;
  edit(doc);
  ok(await as('PUT', `/workflows/${id}`, { baseRevision: current.revision, document: doc }));
}

const designOf = async (flow: string) => ok(await as('GET', `/workflows/${ids.get(flow)}/design`));

/** A requirement agreed at r1 against `workflowId`, its BC-1 tracing `step`. */
async function agreedTracing(workflowId: string, step: string): Promise<string> {
  const key = ok(
    await as('POST', '/requirements', {
      title: 'The coordinator reaches the patient',
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

let requirement = '';
let feedbackKey = '';
let draftIssueId = '';

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  say = requester(app, { owner: await signUserToken(ownerId) });

  // BC-10 and BC-23: access moves to r2 with a change no criterion traces; ux only moves its pin
  const access = await approvedAt1('access');
  await approvedAt1('ux', [{ workflow: 'access', revision: 1 }]);
  requirement = await agreedTracing(access, 'case');
  await rewrite('access', (d) => {
    d.steps[0].node.label = 'Hospital HIS (renamed, untraced)';
  });
  ok(
    await as('POST', `/workflows/${access}/design/decision`, { revision: 2, decision: 'approve' }),
  );
  await rewrite('ux', (d) => {
    d.basedOn = [{ workflow: 'access', revision: 2 }];
  });

  // Feedback triage r16: answered, so it reads resolved, and its record reads the problem gone
  feedbackKey = ok(
    await as('POST', '/feedback', {
      kind: 'question',
      title: 'Why is the board read-only?',
      screen: '/projects/hop/board',
    }),
    201,
  ).feedback.key as string;
  ok(
    await as('POST', `/feedback/${feedbackKey}/triage`, {
      answers: TRIAGE_ANSWERS,
      route: 'answer',
      answer: 'It is by design.',
    }),
  );
  const [fb] = await rows<{ id: string }>(sql`
    SELECT id FROM feedback WHERE project_id = ${projectId} AND fb_seq = ${Number(feedbackKey.slice(3))}`);
  const { unplant } = await vouchedByPassingCriterion({
    token: await userToken(ownerId),
    projectId,
    ownerId,
    feedbackId: fb?.id as string,
    seq: 940,
    sha: '5555555555555555555555555555555555555555',
  });
  onTeardown.push(unplant);
  await rows(sql`
    UPDATE feedback SET resolved_seen_at = now() - interval '60 days' WHERE id = ${fb?.id}`);

  // Issue lifecycle r15: a draft whose ready checklist its own record completes
  draftIssueId = (await createReadyDraftIssue(projectId, ownerId, 950)).id;

  // every consumer works what the setup emitted, then every cluster timer runs, then the consumers again
  await settleOutbox();
  const cluster = coreTimers().filter((t) => t.kind === 'cluster');
  expect(cluster.length).toBeGreaterThan(0);
  // what a timer does to anything else is not this file's question, so its failure is its own
  for (const timer of cluster) await Promise.resolve(timer.run()).catch(() => undefined);
  await settleOutbox();
}, 180_000);

afterAll(async () => {
  for (const undo of onTeardown) undo();
  await closeWorld();
});

describe('nothing moves by itself through every consumer and every cluster timer', () => {
  it('re-pins no requirement on a design approval: it waits on its mover (REQ-41 BC-10)', async () => {
    const acts = await rows<{ act: string }>(sql`
      SELECT b.act FROM requirement_baselines b JOIN requirements r ON r.id = b.requirement_id
       WHERE r.project_id = ${projectId} AND r.req_seq = ${Number(requirement.slice(4))} ORDER BY b.seq`);
    expect(
      acts.map((b) => b.act),
      'REQ-41 BC-10: nothing re-pins a requirement by itself',
    ).toEqual(['agree']);
    const standing = ok(await as('GET', `/requirements/${requirement}`)).standing as Doc;
    expect((standing.waitingOn as Doc).act).toBe(
      'Update to the approved design: Post-discharge follow-up (revision 2)',
    );
  });

  it('approves no pin-only design revision: it waits inside its base act (REQ-41 BC-23)', async () => {
    const ux = await designOf('ux');
    expect(ux.status, 'REQ-41 BC-23: nothing approves itself, a pin-only revision included').toBe(
      'proposed',
    );
    expect(ux.revisions[0]).toMatchObject({ revision: 2, decision: null });
    const kernel = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM project_workflow_designs d JOIN project_workflows w ON w.id = d.workflow_id
       WHERE w.project_id = ${projectId} AND d.decided_kind = 'kernel'`);
    expect(kernel[0]?.n, 'REQ-41 BC-23: no decision names the kernel').toBe(0);
  });

  it('verifies no resolved feedback item whose record reads it gone: it waits on a triager (Feedback triage r16)', async () => {
    const item = ok(await as('GET', `/feedback/${feedbackKey}`)).feedback as Doc;
    expect(item.status, 'Feedback triage r16: nothing verifies an item by itself').toBe('triaged');
    expect(item.phase).toBe('resolved');
    expect(String((item.verifyHeld as Doc | null)?.why)).toMatch(/^the record reads it gone: /);
  });

  it('opens no draft issue whose ready checklist is complete (Issue lifecycle r15)', async () => {
    const [issue] = await rows<{ status: string }>(sql`
      SELECT status FROM issues WHERE id = ${draftIssueId}`);
    expect(issue?.status, 'Issue lifecycle r15: nothing opens an issue by itself').toBe('draft');
  });
});
