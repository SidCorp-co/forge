/**
 * GET /api/projects/:id/raised-questions on the rows a live project really holds (dev.251,
 * /projects/forge/questions read "354 owed · 212 answered", about 38k words): merge claims and run
 * notes printed whole as questions owed on issues that had ended. The business rules under test: a
 * question is owed only while the issue it sits on is live, and one on an ended issue is closed; a
 * row is the question's short form, never its body; Forge's own merge claim is never a question;
 * and the three counts cover every question exactly once.
 *
 * @direct-test-of packages/core/src/comments/raised-read.ts
 * @direct-test-of packages/contracts/src/comments.ts
 */

import { randomUUID } from 'node:crypto';
import { RAISED_QUESTION_SUMMARY_MAX } from '@forge/contracts/comments';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  createTestUser,
  rows,
  seedIssueStatus,
} from '../helpers/factories.js';
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

async function project(): Promise<{ id: string; raised: (who: Who, by?: string) => Promise<Doc> }> {
  const id = (await createTestProject(ownerId)).id;
  await addProjectMember(id, memberId, 'member');
  await seedProjectDocument(id, ownerId, {
    environments: { live: { tier: 'production', deployment: { mode: 'external' } } },
  });
  return {
    id,
    raised: async (who, by = 'me') =>
      ok(await say(who, 'GET', `/api/projects/${id}/raised-questions?by=${by}`)),
  };
}

/** The question's id: the newest comment its asker left on the issue. */
async function asked(issueId: string, body: string, who: Who = 'member'): Promise<string> {
  ok(await say(who, 'POST', `/api/issues/${issueId}/comments`, { intent: 'question', body }), 201);
  const [row] = await rows<{ id: string }>(sql`
    SELECT id FROM comments WHERE issue_id = ${issueId} ORDER BY created_at DESC, id DESC LIMIT 1`);
  if (!row) throw new Error('the question was not written');
  return row.id;
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

describe('a question on an issue that has ended is closed, never owed', () => {
  it('reads owed while the issue is live, and closed once it is dropped or closed', async () => {
    const p = await project();
    const dropped = await issueIn(p.id);
    const shipped = await issueIn(p.id);
    const live = await issueIn(p.id);
    const q1 = await asked(dropped, 'Is this blocked on the export?');
    const q2 = await asked(shipped, 'Does the fix cover the mobile board?');
    const q3 = await asked(live, 'Who owns the export?');
    expect(await p.raised('member')).toMatchObject({ owed: 3, answered: 0, closed: 0 });

    await seedIssueStatus(dropped, 'dropped');
    await rows(sql`UPDATE issues SET merged_at = now() WHERE id = ${shipped}`);
    await seedIssueStatus(shipped, 'closed');
    const mine = await p.raised('member');
    expect(mine).toMatchObject({ owed: 1, answered: 0, closed: 2 });
    const byId = new Map((mine.questions as Doc[]).map((q) => [q.id, q]));
    expect(byId.get(q3)).toMatchObject({ state: 'owed', owedBy: 'agent', answer: null });
    for (const id of [q1, q2]) {
      expect(byId.get(id)).toMatchObject({ state: 'closed', owedBy: null, answer: null });
    }
    // owed first, then the closed ones
    expect((mine.questions as Doc[]).map((q) => q.state)).toEqual(['owed', 'closed', 'closed']);
  });

  it('reads closed on an archived issue, and owed again once the issue reopens', async () => {
    const p = await project();
    const issue = await issueIn(p.id);
    await asked(issue, 'Is the archive the right place for this?');
    await rows(sql`UPDATE issues SET archived_at = now() WHERE id = ${issue}`);
    expect(await p.raised('member')).toMatchObject({ owed: 0, closed: 1 });
    await rows(sql`UPDATE issues SET archived_at = NULL WHERE id = ${issue}`);
    expect(await p.raised('member')).toMatchObject({ owed: 1, closed: 0 });
  });

  it('keeps a question answered before its issue ended as answered', async () => {
    const p = await project();
    const issue = await issueIn(p.id);
    const q = await asked(issue, 'Is this blocked on the export?');
    ok(
      await say('owner', 'POST', `/api/issues/${issue}/comments`, {
        intent: 'note',
        body: 'No: the export shipped yesterday.',
        parentId: q,
      }),
      201,
    );
    await seedIssueStatus(issue, 'dropped');
    const mine = await p.raised('member');
    expect(mine).toMatchObject({ owed: 0, answered: 1, closed: 0 });
    expect(mine.questions[0]).toMatchObject({
      id: q,
      state: 'answered',
      answer: { summary: 'No: the export shipped yesterday.' },
    });
  });
});

describe('a raised question is listed by its short form, never its body', () => {
  it('lists a long question by its first sentence, within the bound, with no body field', async () => {
    const p = await project();
    const issue = await issueIn(p.id);
    const tail = Array.from({ length: 400 }, (_, i) => `detail${i}`).join(' ');
    const body = `Does the export keep archived cards? ${tail}\n\n## Context\n\n${tail}`;
    expect(body.length).toBeGreaterThan(3000);
    const q = await asked(issue, body);
    const long = `${Array.from({ length: 80 }, (_, i) => `clause${i}`).join(' ')}?`;
    const q2 = await asked(issue, long);
    const mine = await p.raised('member');
    const byId = new Map((mine.questions as Doc[]).map((r) => [r.id, r]));
    expect(byId.get(q)?.summary).toBe('Does the export keep archived cards?');
    const cut = byId.get(q2)?.summary as string;
    expect(cut.length).toBeLessThanOrEqual(RAISED_QUESTION_SUMMARY_MAX);
    expect(cut.endsWith('…')).toBe(true);
    for (const row of mine.questions as Doc[]) {
      expect(row).not.toHaveProperty('body');
      expect(JSON.stringify(row)).not.toContain('detail399');
    }
  });
});

describe('Forge’s own merge claim is never a question', () => {
  it('lists no merge claim the marker wrote under a person’s account', async () => {
    const p = await project();
    const issue = await issueIn(p.id);
    ok(await say('owner', 'POST', `/api/issues/${issue}/merge`, { target: 'dev', note: 'landed' }));
    const [trail] = await rows<{ body: string; intent: string }>(sql`
      SELECT body, intent FROM comments WHERE issue_id = ${issue} ORDER BY created_at DESC LIMIT 1`);
    expect(trail?.body).toMatch(/^mark_merged target=dev/);
    expect(await p.raised('owner')).toMatchObject({
      questions: [],
      owed: 0,
      answered: 0,
      closed: 0,
    });
    expect(await p.raised('owner', 'people')).toMatchObject({ questions: [] });
  });
});

describe('the counts cover every question exactly once', () => {
  it('counts owed, answered and closed as the rows read them, for the asker and for everyone', async () => {
    const p = await project();
    const live = await issueIn(p.id);
    const ended = await issueIn(p.id);
    await asked(live, 'One?');
    const answered = await asked(live, 'Two?');
    await asked(ended, 'Three?');
    await asked(live, 'The owner asks too?', 'owner');
    ok(
      await say('owner', 'POST', `/api/issues/${live}/comments`, {
        intent: 'note',
        body: 'Yes.',
        parentId: answered,
      }),
      201,
    );
    await seedIssueStatus(ended, 'dropped');
    for (const [who, by, total] of [
      ['member', 'me', 3],
      ['owner', 'people', 4],
    ] as const) {
      const read = await p.raised(who, by);
      const tally = (state: string) =>
        (read.questions as Doc[]).filter((q) => q.state === state).length;
      expect(read.questions).toHaveLength(total);
      expect(read.owed + read.answered + read.closed).toBe(total);
      expect(read.owed).toBe(tally('owed'));
      expect(read.answered).toBe(tally('answered'));
      expect(read.closed).toBe(tally('closed'));
    }
  });
});
