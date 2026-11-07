/**
 * A park's question is owed by what the park waits on (ISS-1127). epod ISS-63 was parked at
 * `needs_resource` on forge ISS-1125's production monitor, and its question opened as `human`, so it
 * sat in the owner's Needs you though no person owed an act. A resource, or another issue the park's
 * `needs` names, is the master's (`master_or_peer`); the issue's own merge mark answers its question
 * (`machine`); an answer or a decision a person owes stays `human` and stays in Needs you.
 */

// @direct-test-of packages/core/src/issues/park-owed.ts
// @direct-test-of packages/core/src/issues/park-question.ts
// @direct-test-of packages/core/src/questions/write.ts
// @direct-test-of packages/core/src/questions/needs-you-read.ts

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  closeWorld,
  type Doc,
  type EcosystemWorld,
  formEcosystem,
  ok,
  openWorld,
  type Reply,
  requester,
  settleOutbox,
  writeInterfaces,
} from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestUser, rows } from '../helpers/factories.js';

let w: EcosystemWorld;
let projectId: string;
let ownerId: string;
let say: (who: 'owner' | 'master', method: string, path: string, body?: Doc) => Promise<Reply>;

beforeAll(async () => {
  w = await openWorld();
  await formEcosystem(w);
  await writeInterfaces(w);
  projectId = w.project.forge;
  ownerId = w.user.platform;
  const { mintPat } = await import('../../src/credentials/pat.js');
  const agent = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, agent, 'member');
  say = requester(w.app, {
    owner: w.token.platform,
    master: (
      await mintPat({ permissions: ['*'], userId: agent, name: 'master', projectIds: [projectId] })
    ).plaintext,
  });
}, 180_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await settleOutbox();
});

let seq = 11270;
/** An issue planted at `in_progress`, the status its park returns to. */
async function plantIssue(): Promise<{ id: string; key: string }> {
  const id = randomUUID();
  seq += 1;
  const { db } = await import('../../src/db/client.js');
  const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
  await withKernelMarker(db, (tx) =>
    tx.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${id}, ${projectId}, ${seq}, ${`planted ${seq}`}, 'in_progress', ${ownerId})
    `),
  );
  return { id, key: `ISS-${seq}` };
}

const park = async (issueId: string, body: Doc) => {
  ok(
    await say('master', 'POST', `/api/issues/${issueId}/transition`, {
      toStatus: 'needs_info',
      ...body,
    }),
  );
  await settleOutbox();
  const [q] = await rows<{ id: string; blocker_kind: string }>(sql`
    SELECT id, blocker_kind FROM agent_questions
     WHERE issue_id = ${issueId} AND status = 'open' ORDER BY created_at DESC, id DESC LIMIT 1
  `);
  expect(q, 'the park asked no question').toBeDefined();
  return q as { id: string; blocker_kind: string };
};

/** Every word the owner's Needs you serves: its decisions and its rows. */
const ownersNeedsYou = async () =>
  JSON.stringify([
    ok(await say('owner', 'GET', `/api/projects/${projectId}/needs-you/decisions`)),
    ok(await say('owner', 'GET', `/api/projects/${projectId}/needs-you`)),
  ]);

describe('a park on a resource or another issue is no person’s (ISS-1127)', () => {
  it('a park at needs_resource whose needs names another issue is the master’s, never in Needs you', async () => {
    const issue = await plantIssue();
    const q = await park(issue.id, {
      reason: 'The production monitor this check reads is not deployed yet.',
      waitingKind: 'needs_resource',
      needs: 'forge ISS-1125, the production monitor, deployed',
    });
    expect(q.blocker_kind).toBe('master_or_peer');
    expect(await ownersNeedsYou()).not.toContain(q.id);
    const { questionsOwedToAgents } = await import('../../src/questions/index.js');
    expect((await questionsOwedToAgents(projectId)).map((o) => o.id)).toContain(q.id);
    // the issue still reads what it waits on, and that its park asks it
    const parkView = ok(await say('owner', 'GET', `/api/issues/${issue.id}/park`)).park as Doc;
    expect(parkView.owes).toBe('resource');
    expect(parkView.openQuestionIds).toEqual([q.id]);
  });

  it('a decision park whose needs names another issue waits on that delivery, the master’s', async () => {
    const issue = await plantIssue();
    const q = await park(issue.id, {
      reason: 'The export reads the format the other issue settles.',
      waitingKind: 'needs_decision',
      needs: 'ISS-9001 landed, which fixes the export format',
    });
    expect(q.blocker_kind).toBe('master_or_peer');
    expect(await ownersNeedsYou()).not.toContain(q.id);
  });

  it('a park on its own merge mark is answered by the mark, no person’s', async () => {
    const issue = await plantIssue();
    const q = await park(issue.id, {
      reason: 'Waits on its own landing.',
      waitingKind: 'needs_answer',
      awaitsMerge: { issueId: issue.id },
    });
    expect(q.blocker_kind).toBe('machine');
    expect(await ownersNeedsYou()).not.toContain(q.id);
  });

  it('a decision a person owes stays theirs, even where its needs names the parked issue itself', async () => {
    const issue = await plantIssue();
    const q = await park(issue.id, {
      reason: 'Which GitLab group does the mirror read from?',
      waitingKind: 'needs_decision',
      needs: `the group ${issue.key} mirrors, and who decided`,
    });
    expect(q.blocker_kind).toBe('human');
    // the read the planted parks were in: a person's park question is there
    expect(await ownersNeedsYou()).toContain(q.id);
  });
});
