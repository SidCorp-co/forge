/**
 * Only a comment marked as a question is owed a reply: a note, a reply and an explicit note owe
 * nothing by any door, a PAT's comment with no intent is stored as a note and says so, an intent
 * outside the closed set is refused by name, and the project master owes a reply to exactly the
 * questions (`devices/comment-inbox.ts:readOwedComments`). A question waiting on a person is read in
 * Approvals and on its item; there is no Questions page (REQ-33 BC-8).
 *
 * @direct-test-of packages/core/src/comments/issue-comment.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeWorld,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestProject, createTestUser, rows } from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

type Who = 'owner' | 'member';
let say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
let ownerId = '';
let memberId = '';

let seq = 0;
async function issueIn(projectId: string, status = 'in_progress'): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await rows(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${status}, ${ownerId})`);
  return id;
}

async function project(): Promise<{ id: string }> {
  const id = (await createTestProject(ownerId)).id;
  await addProjectMember(id, memberId, 'member');
  await seedProjectDocument(id, ownerId, {
    environments: { live: { tier: 'production', deployment: { mode: 'external' } } },
  });
  return { id };
}

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  memberId = (await createTestUser({ verified: true })).id;
  say = requester(app, {
    owner: await signUserToken(ownerId),
    member: await signUserToken(memberId),
  });
}, 120_000);

afterAll(closeWorld);

describe('only a comment marked as a question is owed a reply', () => {
  async function viaPat(projectId: string): Promise<typeof say> {
    const { mintPat } = await import('../../src/credentials/pat.js');
    const { plaintext } = await mintPat({
      permissions: ['*'],
      userId: memberId,
      name: `operator laptop ${projectId}`,
      projectIds: [projectId],
    });
    const { app } = await import('../../src/index.js');
    return requester(app, { member: plaintext });
  }

  async function masterOwes(projectId: string): Promise<string[]> {
    const { readOwedComments } = await import('../../src/devices/index.js');
    return (await readOwedComments(projectId)).items.map((o) => o.commentId);
  }

  it('stores a comment a person sends through a PAT with no intent as a note, owed nothing', async () => {
    const p = await project();
    const issue = await issueIn(p.id);
    const pat = await viaPat(p.id);
    const written = ok(
      await pat('member', 'POST', `/api/issues/${issue}/comments`, {
        body: 'Merged to dev in #1067; landing on beta next.',
      }),
      201,
    );
    expect(written.intent).toBe('note');
    expect(written.warnings).toEqual([expect.stringMatching(/^COMMENT_INTENT_DEFAULTED: .*note/)]);
    expect(await masterOwes(p.id)).toEqual([]);
  });

  it('owes a reply to the same PAT’s comment once it is sent with intent question', async () => {
    const p = await project();
    const issue = await issueIn(p.id);
    const pat = await viaPat(p.id);
    const written = ok(
      await pat('member', 'POST', `/api/issues/${issue}/comments`, {
        intent: 'question',
        body: 'Does the landing cover the mobile board?',
      }),
      201,
    );
    expect(written.intent).toBe('question');
    expect(written).not.toHaveProperty('warnings');
    expect(await masterOwes(p.id)).toEqual([written.id]);
  });

  it('owes nothing to a reply or an explicit note with no question mark on it, by any door', async () => {
    const p = await project();
    const issue = await issueIn(p.id);
    const pat = await viaPat(p.id);
    const top = ok(
      await say('member', 'POST', `/api/issues/${issue}/comments`, { body: 'Landed on dev.' }),
      201,
    );
    expect(top.intent).toBe('note');
    const reply = ok(
      await pat('member', 'POST', `/api/issues/${issue}/comments`, {
        body: 'And on beta.',
        parentId: top.id,
      }),
      201,
    );
    expect(reply.intent).toBe('note');
    ok(
      await pat('member', 'POST', `/api/issues/${issue}/comments`, {
        intent: 'note',
        body: 'Verified on dev.251.',
      }),
      201,
    );
    expect(await masterOwes(p.id)).toEqual([]);
  });

  it('refuses an intent outside the closed set by name and writes nothing', async () => {
    const p = await project();
    const issue = await issueIn(p.id);
    const pat = await viaPat(p.id);
    const refused = await pat('member', 'POST', `/api/issues/${issue}/comments`, {
      intent: 'Question',
      body: 'Is this owed?',
    });
    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused.json)).toContain('COMMENT_INTENT_UNKNOWN');
    const [count] = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM comments WHERE issue_id = ${issue}`,
    );
    expect(count?.n).toBe(0);
    expect(await masterOwes(p.id)).toEqual([]);
  });
});
