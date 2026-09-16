/**
 * ISS-1056 — the weekly reading's reads against real Postgres: the window's rows by project and
 * bound, oldest first, one door when asked; the benchmark's rooms recognised by title; UUID links
 * resolved against `issues.id`; the pinned issue's newest history file and its published check,
 * which a failure comment never satisfies.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let uploadsDir: string;
let readWeekRows: typeof import('../../src/assistant/weekly/read-rows.js').readWeekRows;
let lookupsFor: typeof import('../../src/assistant/weekly/read-rows.js').lookupsFor;
let hasPublishedReport: typeof import('../../src/assistant/weekly/previous.js').hasPublishedReport;
let readPreviousHistory: typeof import('../../src/assistant/weekly/previous.js').readPreviousHistory;
let postWeeklyComment: typeof import('../../src/assistant/weekly/post.js').postWeeklyComment;
let postWeeklyFailure: typeof import('../../src/assistant/weekly/post.js').postWeeklyFailure;
let listCommentAttachmentsForIssue: typeof import('../../src/comments/attachment-service.js').listCommentAttachmentsForIssue;

const FROM = new Date('2026-09-07T00:00:00Z');
const TO = new Date('2026-09-14T00:00:00Z');
const WINDOW = '2026-09-07..2026-09-14';

beforeAll(async () => {
  harness = await setupTestDatabase();
  uploadsDir = mkdtempSync(join(tmpdir(), 'iss1056-uploads-'));
  process.env.DATABASE_URL = harness.url;
  process.env.UPLOADS_DIR = uploadsDir;
  process.env.STORAGE_DRIVER = 'local';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.SMTP_HOST ??= 'localhost';
  process.env.SMTP_PORT ??= '1025';
  ({ readWeekRows, lookupsFor } = await import('../../src/assistant/weekly/read-rows.js'));
  ({ hasPublishedReport, readPreviousHistory } = await import(
    '../../src/assistant/weekly/previous.js'
  ));
  ({ postWeeklyComment, postWeeklyFailure } = await import('../../src/assistant/weekly/post.js'));
  ({ listCommentAttachmentsForIssue } = await import('../../src/comments/attachment-service.js'));
});

afterAll(async () => {
  await harness.cleanup();
  rmSync(uploadsDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

async function seed() {
  const owner = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, owner.id);
  const issueRows = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO issues (project_id, title, created_by_id) VALUES (${project.id}, 'assistant weekly', ${owner.id}) RETURNING id
  `);
  const issueId = (issueRows[0] as { id: string }).id;
  return { owner, project, issueId };
}

async function room(title: string | null): Promise<string> {
  const rows = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO conversations (adapter, external_id, title) VALUES ('web', ${`ext-${Math.random()}`}, ${title}) RETURNING id
  `);
  return (rows[0] as { id: string }).id;
}

async function log(args: {
  slug: string;
  at: string;
  sessionId?: string | null;
  source?: string;
  reply?: string | null;
  query?: string;
}): Promise<string> {
  const rows = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO chat_logs (session_id, project_slug, query, reply, model, source, created_at, iterations)
    VALUES (${args.sessionId ?? null}, ${args.slug}, ${args.query ?? 'how many open issues'}, ${args.reply ?? 'There are 3.'}, 'm1', ${args.source ?? 'web'}, ${args.at}, 1)
    RETURNING id
  `);
  return (rows[0] as { id: string }).id;
}

describe('readWeekRows', () => {
  it('reads the project rows inside [from, to) oldest first, other projects and both bounds excluded', async () => {
    const { project } = await seed();
    const inside2 = await log({ slug: project.slug, at: '2026-09-10T12:00:00Z' });
    const inside1 = await log({ slug: project.slug, at: '2026-09-07T00:00:00Z' });
    await log({ slug: project.slug, at: '2026-09-14T00:00:00Z' });
    await log({ slug: project.slug, at: '2026-09-06T23:59:59Z' });
    await log({ slug: 'other', at: '2026-09-10T12:00:00Z' });
    const { rows, benchRooms } = await readWeekRows(
      { projectSlug: project.slug, from: FROM, to: TO },
      harness.db,
    );
    expect(rows.map((r) => r.id)).toEqual([inside1, inside2]);
    expect(rows[0]?.createdAt).toBe('2026-09-07T00:00:00.000Z');
    expect(benchRooms).toEqual([]);
  });

  it('reads one door when asked, and names the bench rooms among the rows by their title', async () => {
    const { project } = await seed();
    const bench = await room('bench 20260910-abc issue-count');
    const person = await room('Thanh and the assistant');
    const untitled = await room(null);
    await log({ slug: project.slug, at: '2026-09-08T00:00:00Z', sessionId: bench });
    await log({ slug: project.slug, at: '2026-09-08T01:00:00Z', sessionId: person });
    await log({
      slug: project.slug,
      at: '2026-09-08T02:00:00Z',
      sessionId: untitled,
      source: 'rocketchat',
    });
    await log({ slug: project.slug, at: '2026-09-08T03:00:00Z', sessionId: null });
    const all = await readWeekRows({ projectSlug: project.slug, from: FROM, to: TO }, harness.db);
    expect(all.rows).toHaveLength(4);
    expect(all.benchRooms).toEqual([bench]);
    const web = await readWeekRows(
      { projectSlug: project.slug, from: FROM, to: TO, source: 'web' },
      harness.db,
    );
    expect(web.rows.map((r) => r.source)).toEqual(['web', 'web', 'web']);
  });

  it('resolves UUID issue links against issues.id and marks the rest dead', async () => {
    const { project, issueId } = await seed();
    const dead = '00000000-0000-4000-8000-000000000000';
    await log({
      slug: project.slug,
      at: '2026-09-08T00:00:00Z',
      reply: `See /projects/${project.slug}/issues/${issueId} and /projects/${project.slug}/issues/${dead}.`,
    });
    const { rows } = await readWeekRows(
      { projectSlug: project.slug, from: FROM, to: TO },
      harness.db,
    );
    const lookups = await lookupsFor(rows, harness.db);
    expect(lookups[issueId]).toBe('resolves');
    expect(lookups[dead]).toBe('dead');
  });
});

describe('the pinned issue as the series', () => {
  const history = (from: string, to: string) => ({
    at: '2026-09-14T04:00:00.000Z',
    api: 'in-process',
    commit: 'abc',
    version: '0',
    window: { projectSlug: 'qa', from, to, source: null },
    budgetSeconds: 60,
    maxIterations: 8,
    resolved: true,
    excludedSessions: [],
    excludedRows: 0,
    groups: [],
    flagged: [],
  });

  it('has no previous file and no published report on a fresh issue', async () => {
    const { issueId } = await seed();
    expect(await readPreviousHistory(issueId, harness.db)).toBeNull();
    expect(await hasPublishedReport(issueId, WINDOW, harness.db)).toBe(false);
  });

  it('after a post, the report is published for its window only and its history file is the previous one', async () => {
    const { owner, issueId } = await seed();
    const body = `Assistant weekly reading ${WINDOW}: 12 rows — thin (under 30)\n\nbody`;
    await postWeeklyComment({
      issueId,
      authorId: owner.id,
      report: {
        body,
        files: [
          {
            name: `assistant-history-${WINDOW}.json`,
            mime: 'text/plain',
            text: JSON.stringify(history('2026-09-07', '2026-09-14')),
          },
          { name: `candidate-x-${WINDOW}.ts.txt`, mime: 'text/plain', text: '// candidate\n' },
        ],
      },
    });
    expect(await hasPublishedReport(issueId, WINDOW, harness.db)).toBe(true);
    expect(await hasPublishedReport(issueId, '2026-09-14..2026-09-21', harness.db)).toBe(false);
    const attached = [...(await listCommentAttachmentsForIssue(issueId)).values()].flat();
    expect(attached.map((a) => a.name).sort()).toEqual(
      [`assistant-history-${WINDOW}.json`, `candidate-x-${WINDOW}.ts.txt`].sort(),
    );
    const previous = await readPreviousHistory(issueId, harness.db);
    expect(previous?.window.from).toBe('2026-09-07');
  });

  it('a failure comment is not a published report, and the newest history file wins', async () => {
    const { owner, issueId } = await seed();
    await postWeeklyFailure({
      issueId,
      authorId: owner.id,
      windowId: WINDOW,
      error: { name: 'TypeError', message: 'boom' },
    });
    expect(await hasPublishedReport(issueId, WINDOW, harness.db)).toBe(false);
    for (const [from, to] of [
      ['2026-08-24', '2026-08-31'],
      ['2026-08-31', '2026-09-07'],
    ] as const) {
      await postWeeklyComment({
        issueId,
        authorId: owner.id,
        report: {
          body: `Assistant weekly reading ${from}..${to}: 40 rows\n\nbody`,
          files: [
            {
              name: `assistant-history-${from}..${to}.json`,
              mime: 'text/plain',
              text: JSON.stringify(history(from, to)),
            },
          ],
        },
      });
    }
    const previous = await readPreviousHistory(issueId, harness.db);
    expect(previous?.window.from).toBe('2026-08-31');
  });
});
