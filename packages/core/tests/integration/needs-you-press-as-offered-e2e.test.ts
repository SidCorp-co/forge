/**
 * A Needs-you button pressed as it is offered succeeds (REQ-41 BC-2, BC-23). Two defects found on
 * dev.281, 2026-10-22, clearing Approvals:
 *
 * - The requirement re-pin decision ("Follow the approved designs and contracts in REQ-18 at revision
 *   1?") said `needsReason: false` with `body: { revision: 1 }`, and the route refused that body
 *   REQUIREMENT_SIGNOFF_REASON_REQUIRED: a sign-off that writes a baseline records why (REQ-4 BC-4,
 *   ADR 0007), so the decision declares the reason the route needs, as the requirement page does.
 * - Approving requirement-to-delivery's re-pin moved design-reconciliation r18 → r19, re-pinning every
 *   base it follows at once; the next three bases' decisions, read at the same time and naming it at
 *   r18, were refused 409 WORKFLOW_DESIGN_REVISION_STALE though nothing in it but its pins had moved.
 *   A design that moved only by re-pins is re-read at act time; one whose content changed is still
 *   refused by name.
 *
 * @direct-test-of packages/core/src/workflows/design-repin-service.ts
 * @direct-test-of packages/core/src/development/needs-you-accept-builders.ts
 * @direct-test-of packages/core/src/development/needs-you-approve-builders.ts
 */

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  addProjectMember,
  createTestProject,
  createTestUser,
  makeAgreeReady,
} from '../helpers/factories.js';

let projectId = '';
let say: (who: 'owner' | 'master', method: string, path: string, body?: Doc) => Promise<Reply>;
const ids = new Map<string, string>();
const at = (path: string) => `/api/projects/${projectId}${path}`;
const as = (method: string, path: string, body?: Doc) => say('owner', method, at(path), body);

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

async function approvedAt1(flow: string, basedOn?: Doc[]): Promise<string> {
  const made = ok(
    await say('master', 'POST', at('/workflows'), {
      baseRevision: null,
      document: design(flow, basedOn),
    }),
    201,
  );
  const id = made.document.id as string;
  ids.set(flow, id);
  ok(await say('master', 'POST', at(`/workflows/${id}/design/propose`), { revision: 1 }));
  ok(await as('POST', `/workflows/${id}/design/decision`, { revision: 1, decision: 'approve' }));
  return id;
}

/** Writes the design's next revision as `edit` makes it, and approves it. */
async function approveNext(flow: string, edit: (d: Doc) => void): Promise<void> {
  const current = ok(await say('master', 'GET', at(`/workflows/${ids.get(flow)}`)));
  const { id, createdAt, updatedAt, ...doc } = current.document;
  void createdAt;
  void updatedAt;
  edit(doc);
  ok(
    await say('master', 'PUT', at(`/workflows/${id}`), {
      baseRevision: current.revision,
      document: doc,
    }),
  );
  ok(
    await as('POST', `/workflows/${id}/design/decision`, {
      revision: current.revision + 1,
      decision: 'approve',
    }),
  );
  await settleOutbox();
}

const decisions = async () =>
  (ok(await as('GET', '/needs-you/decisions')).decisions as Doc[]) ?? [];

/** The body the Approvals page sends for `answer` (`needs-you/api.ts:pressBody`), typing `typed` where it asks. */
function pressBody(answer: Doc, typed: string): Doc {
  const body = { ...((answer.body as Doc | null) ?? {}) };
  if (!answer.needsReason) return body;
  const field = answer.act !== 'question.answer' ? 'reason' : 'optionId' in body ? 'note' : 'text';
  body[field] = typed;
  return body;
}

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const { mintPat } = await import('../../src/credentials/pat.js');
  const ownerId = (await createTestUser({ verified: true })).id;
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
  // the requirement re-pin case: REQ-1 agreed against `followed` at r1, then `followed` approved at r2
  await approvedAt1('followed');
  const key = ok(
    await as('POST', '/requirements', {
      title: 'The coordinator reaches the patient',
      reason: 'a discharged patient is called back',
      criteria: [{ body: 'A discharged patient who needs follow-up is called.' }],
    }),
    201,
  ).key as string;
  ok(await as('POST', `/requirements/${key}/workflows`, { workflowId: ids.get('followed') }));
  ok(
    await as('PUT', `/requirements/${key}/criteria/BC-1/steps`, {
      workflow: ids.get('followed'),
      steps: ['case'],
    }),
  );
  await makeAgreeReady(projectId, Number(key.slice(4)), ownerId);
  ok(await as('POST', `/requirements/${key}/revisions/1/propose`, {}));
  ok(await as('POST', `/requirements/${key}/revisions/1/accept`, { reason: 'ok' }));
  ok(await as('POST', `/requirements/${key}/agree`, { revision: 1, reason: 'ok' }));
  ids.set('req', key);
  await approveNext('followed', (d) => {
    d.summary = 'revision two, same steps';
  });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('a requirement re-pin decision declares the reason its route needs (REQ-41 BC-2; REQ-4 BC-4)', () => {
  it('asks the reason, so the Approvals press records it and the re-pin is written', async () => {
    const key = ids.get('req') as string;
    const decision = (await decisions()).find((d) => d.key === key);
    const repin = (decision?.answers as Doc[] | undefined)?.find((a) => a.id === 'repin');
    expect(repin, `${key} waits on a re-pin`).toMatchObject({
      act: 'requirement.repin',
      body: { revision: 1 },
    });
    expect(
      repin?.needsReason,
      'the route refuses a re-pin with no reason, so the button asks for one',
    ).toBe(true);
    // the reason it asks starts from the recommendation's why (REQ-68 BC-2)
    expect(repin?.body?.reason).toBe((decision?.recommended as Doc | undefined)?.why);

    const { reason: _prefilled, ...withoutReason } = (repin?.body ?? {}) as Doc;
    const bare = await say('owner', 'POST', repin?.path as string, withoutReason);
    expect([bare.status, bare.json.code]).toEqual([422, 'REQUIREMENT_SIGNOFF_REASON_REQUIRED']);
    const pressed = await say(
      'owner',
      'POST',
      repin?.path as string,
      pressBody(repin as Doc, 'follows r2, same steps'),
    );
    expect(pressed.status, JSON.stringify(pressed.json)).toBe(200);
    expect((await decisions()).find((d) => d.key === key)).toBeUndefined();
  });
});

describe("a dependent shared by several bases does not turn its siblings' re-pins stale (REQ-41 BC-23)", () => {
  it('approves each base re-pin as read, the shared design re-read at act time', async () => {
    await approvedAt1('requirement-to-delivery');
    await approvedAt1('feedback-lifecycle');
    const both = [
      { workflow: 'requirement-to-delivery', revision: 1 },
      { workflow: 'feedback-lifecycle', revision: 1 },
    ];
    await approvedAt1('design-reconciliation', both);
    await approvedAt1('feedback-intake', [{ workflow: 'feedback-lifecycle', revision: 1 }]);
    await approveNext('requirement-to-delivery', (d) => {
      d.steps[0].node.label = 'Hospital HIS (revised)';
    });
    await approveNext('feedback-lifecycle', (d) => {
      d.steps[0].node.label = 'Hospital HIS (feedback revised)';
    });

    // both decisions read at the same time, as the Approvals page shows them
    const read = await decisions();
    const of = (flow: string) => {
      const decision = read.find((d) => d.id === `repin:${ids.get(flow)}`);
      if (!decision) throw new Error(`no re-pin decision for ${flow}: ${JSON.stringify(read)}`);
      return (decision.answers as Doc[])[0] as Doc;
    };
    const first = of('requirement-to-delivery');
    const second = of('feedback-lifecycle');
    expect((second.body as Doc).designs).toHaveLength(2);

    const one = await say('owner', 'POST', first.path as string, first.body as Doc);
    expect(one.status, JSON.stringify(one.json)).toBe(200);
    expect((one.json.approved as Doc[]).map((a) => [a.flow, a.revision])).toEqual([
      ['design-reconciliation', 2],
    ]);

    const two = await say('owner', 'POST', second.path as string, second.body as Doc);
    expect(two.status, JSON.stringify(two.json)).toBe(200);
    expect((two.json.approved as Doc[]).map((a) => a.flow)).toEqual(['feedback-intake']);
    expect(two.json.alreadyFollowing).toEqual([
      { workflowId: ids.get('design-reconciliation'), flow: 'design-reconciliation', revision: 2 },
    ]);
    expect((await decisions()).filter((d) => String(d.id).startsWith('repin:'))).toEqual([]);
  });

  it('still refuses by name a named design whose content changed since it was read', async () => {
    await approvedAt1('issue-lifecycle');
    await approvedAt1('issue-board', [{ workflow: 'issue-lifecycle', revision: 1 }]);
    await approveNext('issue-lifecycle', (d) => {
      d.steps[0].node.label = 'Hospital HIS (issue revised)';
    });
    const decision = (await decisions()).find(
      (d) => d.id === `repin:${ids.get('issue-lifecycle')}`,
    );
    if (!decision) throw new Error('no re-pin decision for issue-lifecycle');
    const approve = (decision.answers as Doc[])[0] as Doc;
    // someone changes a step of the dependent and it is approved, after the decision was read
    await approveNext('issue-board', (d) => {
      d.steps[0].node.label = 'Board source (renamed)';
      d.basedOn = [{ workflow: 'issue-lifecycle', revision: 2 }];
    });
    const refused = await say('owner', 'POST', approve.path as string, approve.body as Doc);
    expect([refused.status, refused.json.code]).toEqual([409, 'WORKFLOW_DESIGN_REVISION_STALE']);
    expect(refused.json.detail).toContain(
      '"issue-board" was read at revision 1 and stands at revision 2 now',
    );
  });
});
