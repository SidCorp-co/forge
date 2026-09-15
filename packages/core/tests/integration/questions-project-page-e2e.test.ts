/**
 * ISS-1022 — the project-scoped question list, once it is a page and not a dump.
 *
 * Two claims: the list is bounded without lying about how much is behind it,
 * and the row it returns still answers everything a queue reader asks even
 * though `steps` is no longer on it. The second is the one that could go wrong
 * quietly — a projection that drops a field nobody tests for reads as a
 * smaller payload rather than as a missing answer — so every derived field is
 * asserted by value, on both shapes a round can have.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let write: typeof import('../../src/questions/write.js');
let read: typeof import('../../src/questions/read.js');
let ctx: { projectId: string; issueId: string; adminId: string };

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  write = await import('../../src/questions/write.js');
  read = await import('../../src/questions/read.js');
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

const CHOICE_OPTION = {
  id: '11111111-1111-4111-8111-111111111111',
  label: 'Take the safe path',
  authority: 'writer' as const,
  bindsTo: 'session' as const,
  executedBy: 'agent' as const,
};
const ADMIN_OPTION = {
  id: '22222222-2222-4222-8222-222222222222',
  label: 'Deploy it',
  authority: 'admin' as const,
  bindsTo: 'project' as const,
  executedBy: 'human' as const,
};

beforeEach(async () => {
  await truncateAll(harness.db);
  const admin = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, admin.id);
  const { sql } = await import('drizzle-orm');
  const issueId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${issueId}, ${project.id}, 1, 'the issue the questions hang off', 'open', ${admin.id})
  `);
  ctx = { projectId: project.id, issueId, adminId: admin.id };
});

const askChoice = async () =>
  write.askQuestion({
    id: randomUUID(),
    projectId: ctx.projectId,
    issueId: ctx.issueId,
    prompt: 'which way',
    blockerKind: 'human',
    answer: {
      shape: 'choice',
      options: [CHOICE_OPTION, ADMIN_OPTION],
      recommendedOptionId: CHOICE_OPTION.id,
    },
  });

const askFreeText = async () =>
  write.askParkQuestion(harness.db as never, {
    id: randomUUID(),
    projectId: ctx.projectId,
    issueId: ctx.issueId,
    prompt: 'what is the credential',
    needed: 'the read-only connection string',
  });

describe('ISS-1022 · GET /api/questions?projectId= is a page', () => {
  it('returns at most the page size asked for and says more remains', async () => {
    for (let i = 0; i < 7; i++) await askChoice();

    const first = await read.projectQuestionsFor(ctx.projectId, ctx.adminId, undefined, {
      limit: 3,
    });
    expect(first?.questions).toHaveLength(3);
    expect(first?.total).toBe(7);
    expect(first?.hasMore).toBe(true);
  });

  it('reports the uncapped total on every page and no further page on the last one', async () => {
    for (let i = 0; i < 7; i++) await askChoice();

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await read.projectQuestionsFor(ctx.projectId, ctx.adminId, undefined, {
        limit: 3,
        cursor,
      });
      pages += 1;
      expect(page?.total).toBe(7);
      for (const q of page?.questions ?? []) seen.push(q.id as string);
      if (!page?.hasMore) {
        expect(page?.nextCursor).toBeNull();
        break;
      }
      cursor = page.nextCursor as string;
      expect(pages).toBeLessThan(6);
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  // cm:guard the walk is a KEYSET and this is the case that separates it from an offset: a question on the page already read is answered before the next page is asked for, which under an offset shifts every row behind it backward and starts the next page past one of them — a decision dropped from the queue with `hasMore` still reading complete. The cursor names the row it left off at, so nothing in front of it moves (ISS-1022).
  it('reaches every open decision even when one on a page already read is answered mid-walk', async () => {
    const asked: string[] = [];
    for (let i = 0; i < 7; i++) asked.push((await askChoice()).id);

    const first = await read.projectQuestionsFor(ctx.projectId, ctx.adminId, 'open', { limit: 3 });
    expect(first?.questions).toHaveLength(3);

    const { sql } = await import('drizzle-orm');
    const closed = first?.questions[0]?.id as string;
    await harness.db.execute(sql`UPDATE agent_questions SET status = 'void' WHERE id = ${closed}`);

    const seen = (first?.questions ?? []).map((q) => q.id as string).filter((id) => id !== closed);
    let cursor = first?.nextCursor as string | undefined;
    while (cursor) {
      const page = await read.projectQuestionsFor(ctx.projectId, ctx.adminId, 'open', {
        limit: 3,
        cursor,
      });
      for (const q of page?.questions ?? []) seen.push(q.id as string);
      cursor = (page?.nextCursor as string | null) ?? undefined;
    }

    expect(new Set(seen)).toEqual(new Set(asked.filter((id) => id !== closed)));
  });

  // cm:guard the case that separates `hasMore` from "the page came back full": with six rows and a page of three the LAST page holds exactly three, and a `hasMore` read off fullness alone sends the queue to fetch a page that does not exist — the "Load the rest" control offered over nothing (ISS-1022).
  it('says no further page remains on a last page holding exactly the page size', async () => {
    for (let i = 0; i < 6; i++) await askChoice();

    const first = await read.projectQuestionsFor(ctx.projectId, ctx.adminId, undefined, {
      limit: 3,
    });
    expect(first?.questions).toHaveLength(3);
    expect(first?.hasMore).toBe(true);

    const last = await read.projectQuestionsFor(ctx.projectId, ctx.adminId, undefined, {
      limit: 3,
      cursor: first?.nextCursor as string,
    });
    expect(last?.questions).toHaveLength(3);
    expect(last?.hasMore).toBe(false);
    expect(last?.nextCursor).toBeNull();
  });

  // cm:guard the cursor is compared as the WHOLE `(created_at, id)` key at the precision the database holds it: two questions asked in one transaction share a `created_at` to the microsecond, and two more can differ only below the millisecond a JS `Date` can represent. A cursor that carries the timestamp alone loops on the boundary row forever; one rounded to milliseconds re-matches its own row and does the same (ISS-1022).
  it('returns each of a tied and a sub-millisecond timestamp exactly once, and terminates', async () => {
    const asked: string[] = [];
    for (let i = 0; i < 6; i++) asked.push((await askChoice()).id);
    const { sql } = await import('drizzle-orm');
    // cm:guard both hard pairs STRADDLE a page boundary at `limit: 2`, which is the whole discriminating power of this case: descending, the page ends on `…04.000002` with `…04.000001` first on the next one, so a cursor rounded to milliseconds excludes a row it has not returned; and it ends again on one of the two rows tied at `…03.000000`, so a cursor carrying the timestamp WITHOUT the id excludes its twin. Put both pairs inside one page and every wrong cursor passes (ISS-1022).
    const at = [
      '2026-01-01 00:00:05.000000+00',
      '2026-01-01 00:00:04.000002+00',
      '2026-01-01 00:00:04.000001+00',
      '2026-01-01 00:00:03.000000+00',
      '2026-01-01 00:00:03.000000+00',
      '2026-01-01 00:00:02.000000+00',
    ];
    for (const [i, id] of asked.entries()) {
      await harness.db.execute(
        sql`UPDATE agent_questions SET created_at = ${at[i]}::timestamptz WHERE id = ${id}`,
      );
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await read.projectQuestionsFor(ctx.projectId, ctx.adminId, undefined, {
        limit: 2,
        cursor,
      });
      pages += 1;
      for (const q of page?.questions ?? []) seen.push(q.id as string);
      if (!page?.hasMore) break;
      cursor = page.nextCursor as string;
      expect(pages).toBeLessThan(8);
    }

    expect(seen).toHaveLength(6);
    expect(new Set(seen)).toEqual(new Set(asked));
  });

  // cm:guard the two silent readings of a bad cursor, both measured live on beta before this landed: `cursor=abc` had no separator and was DROPPED, so the caller got page one back as though it were the page it asked for — a drain loop that never advances and never says why; and a cursor whose timestamp had been corrupted went into the `::timestamptz` cast and came back a 500, a caller's typo reading as a server fault. Neither is a refusal a caller can act on (ISS-1022).
  it('refuses a cursor it did not mint by name, rather than dropping it or raising on the cast', async () => {
    for (let i = 0; i < 4; i++) await askChoice();
    const { QuestionRefused } = await import('../../src/questions/write.js');

    for (const bad of [
      'abc',
      'not-a-cursor|xyz',
      Buffer.from('2026-09-14 19:40:03.428223 00|90a04d87-76c3-4a49-971e-f2a9f104f95a').toString(
        'base64url',
      ),
      Buffer.from('2026-09-14 19:40:03.428223+00|not-a-uuid').toString('base64url'),
      '2026-09-14 19:40:03.428223+00|90a04d87-76c3-4a49-971e-f2a9f104f95a',
    ]) {
      await expect(
        read.projectQuestionsFor(ctx.projectId, ctx.adminId, undefined, { limit: 2, cursor: bad }),
      ).rejects.toThrow(QuestionRefused);
    }
  });

  // cm:guard the check is on the SHAPE and deliberately not on authenticity: a hand-built key that decodes is a legal starting point, because the cursor grants nothing — the page is already scoped by this caller's role on the project before the cursor is read at all. This case is here so that "refused" is never quietly widened into "issued by us", which would be a claim the implementation does not make (ISS-1022).
  it('accepts a decodable key the caller built itself, because a cursor grants nothing', async () => {
    const asked: string[] = [];
    for (let i = 0; i < 4; i++) asked.push((await askChoice()).id);
    const { sql } = await import('drizzle-orm');
    const [row] = (await harness.db.execute(
      sql`SELECT created_at::text AS at, id::text AS id FROM agent_questions
          ORDER BY created_at DESC, id DESC OFFSET 1 LIMIT 1`,
    )) as unknown as Array<{ at: string; id: string }>;
    const handBuilt = Buffer.from(`${row?.at}|${row?.id}`).toString('base64url');

    const page = await read.projectQuestionsFor(ctx.projectId, ctx.adminId, undefined, {
      limit: 10,
      cursor: handBuilt,
    });
    expect(page?.questions).toHaveLength(2);
    expect(page?.total).toBe(4);
  });

  // cm:guard the cursor must survive a query string UNESCAPED, because "send it back exactly as it arrived" is the whole contract and a caller reading that sentence will do exactly that. The raw key carries a space and a `+`, and `+` in a query string decodes to a space — measured on beta, where the unescaped form answered 500 (ISS-1022).
  it('mints a cursor with no character a query string would alter', async () => {
    for (let i = 0; i < 4; i++) await askChoice();
    const page = await read.projectQuestionsFor(ctx.projectId, ctx.adminId, undefined, {
      limit: 2,
    });
    const cursor = page?.nextCursor as string;

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(new URLSearchParams(`cursor=${cursor}`).get('cursor')).toBe(cursor);

    const next = await read.projectQuestionsFor(ctx.projectId, ctx.adminId, undefined, {
      limit: 2,
      cursor: new URLSearchParams(`cursor=${cursor}`).get('cursor') as string,
    });
    expect(next?.questions).toHaveLength(2);
    expect(new Set((next?.questions ?? []).map((q) => q.id))).not.toEqual(
      new Set((page?.questions ?? []).map((q) => q.id)),
    );
  });

  it('applies a default page size when the caller asks for none', async () => {
    for (let i = 0; i < 3; i++) await askChoice();
    const page = await read.projectQuestionsFor(ctx.projectId, ctx.adminId);
    expect(page?.questions).toHaveLength(3);
    expect(page?.total).toBe(3);
    expect(page?.hasMore).toBe(false);
  });

  it('counts only the questions matching the status filter', async () => {
    await askChoice();
    const voided = await askChoice();
    const { sql } = await import('drizzle-orm');
    await harness.db.execute(
      sql`UPDATE agent_questions SET status = 'void' WHERE id = ${voided.id}`,
    );

    const open = await read.projectQuestionsFor(ctx.projectId, ctx.adminId, 'open', {
      limit: 50,
    });
    expect(open?.total).toBe(1);
    expect(open?.questions).toHaveLength(1);
  });
});

describe('ISS-1022 · the list row answers without carrying the history', () => {
  it('carries no steps array', async () => {
    await askChoice();
    const page = await read.projectQuestionsFor(ctx.projectId, ctx.adminId);
    const row = page?.questions[0] as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.steps).toBeUndefined();
  });

  // cm:guard dropping `steps` is only safe because `currentStep` replaces it: `QuestionCard` in web-v2 renders this queue and reads the live round off the row, so a projection that sends neither leaves that screen drawing an undefined round with a submit bound to nothing. `rounds` is what says how many are not on the row.
  it('replaces the dropped history with the live round and a count of the rest', async () => {
    await askChoice();
    const page = await read.projectQuestionsFor(ctx.projectId, ctx.adminId);
    const row = page?.questions[0] as Record<string, unknown>;
    const current = row.currentStep as Record<string, unknown> | null;
    expect(current).toBeTruthy();
    expect(current?.round).toBe(1);
    expect(current?.prompt).toBe('which way');
    expect(row.rounds).toBe(1);
  });

  // cm:guard the row must say what is being ASKED and which round it is: `POST /api/questions/:id/answer` refuses an answer that does not carry the round the person was shown, so a list carrying the controls without the prompt and the round is a queue a reader can see and cannot answer. Dropping `steps` is what makes these two derived fields load-bearing.
  it('carries the prompt and the round of the live decision, which the dropped array used to carry', async () => {
    await askChoice();
    const page = await read.projectQuestionsFor(ctx.projectId, ctx.adminId);
    const row = page?.questions[0];
    expect(row?.prompt).toBe('which way');
    expect(row?.round).toBe(1);
    expect(row?.askedAt).toBeTruthy();
  });

  it('carries the choice round shape, its locks and its recommended option', async () => {
    await askChoice();
    const page = await read.projectQuestionsFor(ctx.projectId, ctx.adminId);
    const row = page?.questions[0];
    expect(row?.answerShape).toBe('choice');
    expect(row?.recommendedOptionId).toBe(CHOICE_OPTION.id);
    expect(row?.needed).toBe('');
    expect(row?.locked).toBe(false);
    // cm:guard the per-option `locked` verdict is the SERVER's and the list must carry it, not only the detail: an admin-authority option shown unlocked in a queue is a decision the reader is invited to take and will then be refused.
    expect(row?.options.map((o) => [o.id, o.locked])).toEqual([
      [CHOICE_OPTION.id, false],
      [ADMIN_OPTION.id, false],
    ]);
  });

  it('carries the free-text round shape and its needed line', async () => {
    await askFreeText();
    const page = await read.projectQuestionsFor(ctx.projectId, ctx.adminId);
    const row = page?.questions[0];
    expect(row?.answerShape).toBe('free_text');
    expect(row?.needed).toBe('the read-only connection string');
    expect(row?.options).toEqual([]);
    expect(row?.recommendedOptionId).toBe('');
  });

  it('reports how many rounds the decision has had, which the dropped array used to show', async () => {
    await askFreeText();
    const page = await read.projectQuestionsFor(ctx.projectId, ctx.adminId);
    const first = page?.questions[0] as unknown as Record<string, unknown> | undefined;
    expect(first?.rounds).toBe(1);
  });

  it('still carries the whole steps history on the issue-scoped read', async () => {
    await askChoice();
    const seen = await read.readQuestionsForIssue(ctx.issueId, ctx.adminId);
    expect(seen?.[0]?.steps).toHaveLength(1);
    expect(seen?.[0]?.steps[0]?.prompt).toBe('which way');
  });
});
