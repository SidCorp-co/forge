/**
 * Dev, 2026-10-22: the Needs-you decision "Move N designs built on requirement-to-delivery to follow
 * rX" answered approve and was refused CHECKLIST_INCOMPLETE, "REQ-18 links it, and none of their
 * business criteria is traced to a step", though the revisions it approves move nothing but a pin
 * (REQ-41 BC-23). A pin-only revision carries its step answers from the approved revision it re-pins;
 * a revision that changes a step is still asked every question.
 */

import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestProject,
  createTestRequirement,
  createTestUser,
} from '../helpers/factories.js';

let projectId: string;
let ownerId: string;
let say: (who: 'owner' | 'master', method: string, path: string, body?: Doc) => Promise<Reply>;
const ids = new Map<string, string>();
const at = (path: string) => `/api/projects/${projectId}${path}`;

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
  ok(
    await say('owner', 'POST', at(`/workflows/${id}/design/decision`), {
      revision: 1,
      decision: 'approve',
    }),
  );
  return id;
}

async function rewrite(flow: string, edit: (d: Doc) => void): Promise<void> {
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
}

/** A requirement now links the design and traces none of its criteria to a step, as REQ-18 on dev. */
async function linkUntraced(flow: string, seq: number): Promise<void> {
  const req = await createTestRequirement(projectId, seq, `Requirement linking ${flow}`);
  await db.execute(sql`
    INSERT INTO requirement_workflows (requirement_id, workflow_id, linked_by)
    VALUES (${req.id}, ${ids.get(flow)}, ${ownerId})`);
}

const decisionsOf = async () =>
  (ok(await say('owner', 'GET', at('/needs-you/decisions'))).decisions as Doc[]).filter(
    (d) => d.id === `repin:${ids.get('requirement-to-delivery')}`,
  );

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
      await mintPat({ permissions: ['*'], userId: agentId, name: 'master', projectIds: [projectId] })
    ).plaintext,
  });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('a pin-only re-pin of a design whose linking requirement traces nothing (REQ-41 BC-23)', () => {
  it('approves the Needs-you decision as offered, carrying the step answers from the approved revision', async () => {
    await approvedAt1('requirement-to-delivery');
    const on = [{ workflow: 'requirement-to-delivery', revision: 1 }];
    await approvedAt1('issue-lifecycle', on);
    await approvedAt1('billing-ux', on);
    await linkUntraced('issue-lifecycle', 18);
    await linkUntraced('billing-ux', 15);
    await rewrite('requirement-to-delivery', (d) => {
      d.steps[0].node.label = 'Hospital HIS (revised)';
    });
    ok(
      await say('owner', 'POST', at(`/workflows/${ids.get('requirement-to-delivery')}/design/decision`), {
        revision: 2,
        decision: 'approve',
      }),
    );

    const [decision] = await decisionsOf();
    const approve = (decision?.answers as Doc[] | undefined)?.find((a) => a.id === 'approve');
    expect(approve, 'the re-pin is offered as one decision').toBeDefined();
    const pressed = await say('owner', 'POST', approve?.path as string, approve?.body as Doc);
    expect(pressed.status, JSON.stringify(pressed.json)).toBe(200);
    expect((pressed.json.approved as Doc[]).map((a) => a.flow).sort()).toEqual([
      'billing-ux',
      'issue-lifecycle',
    ]);

    const [move] = (await db.execute(sql`
      SELECT checklist_answers FROM kernel_transitions
       WHERE entity = 'workflow_design' AND entity_id = ${ids.get('issue-lifecycle')}
         AND to_status = 'approved' AND checklist_answers IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`)) as unknown as { checklist_answers: Doc[] }[];
    const criteria = move?.checklist_answers.find((a) => a.question === 'criteria');
    expect(criteria?.value).toBe(
      'Unchanged from revision 1, which was approved: this revision changes only which revision it follows (requirement-to-delivery r1 → r2).',
    );
    expect(await decisionsOf()).toEqual([]);
  });

  it('still refuses a revision that changes a step, naming the untraced criteria', async () => {
    await rewrite('billing-ux', (d) => {
      d.steps[0].node.label = 'Billing source (renamed)';
    });
    const id = ids.get('billing-ux') as string;
    const current = ok(await say('owner', 'GET', at(`/workflows/${id}/design`)));
    expect(current.status).toBe('proposed');
    const refused = await say('owner', 'POST', at(`/workflows/${id}/design/decision`), {
      revision: current.revision,
      decision: 'approve',
    });
    expect(refused.status, JSON.stringify(refused.json)).toBe(422);
    expect(JSON.stringify(refused.json)).toContain(
      'REQ-15 links it, and none of their business criteria is traced to a step.',
    );
  });
});
