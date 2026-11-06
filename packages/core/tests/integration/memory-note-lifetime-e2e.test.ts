/**
 * ISS-1063: a note is a lead, so it leaves on its own. A note written for an issue retires when that
 * issue reaches `closed` or `dropped`, unless someone verified it after its last write; a note naming
 * no issue retires once older than the project's note window unverified; every search hit says
 * whether it is verified; and a new `decision` memory is refused, naming the rule and requirement
 * doors, while the rows already there stay readable. Against real Postgres, pg-boss and the outbox.
 *
 * @direct-test-of packages/core/src/memory/note-lifetime.ts
 * @direct-test-of packages/core/src/memory/decay.ts
 * @direct-test-of packages/core/src/memory/write-service.ts
 * @direct-test-of packages/core/src/memory/search-service.ts
 */

import { MEMORY_NOTE_WINDOW_DAYS } from '@forge/contracts/memory';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { runMemoryDecay } from '../../src/memory/index.js';
import { emitEvent } from '../../src/outbox/index.js';
import { DEFAULT_POLICY } from '../../src/project-config/default-policy.js';
import { api, type Body } from '../helpers/api.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser } from '../helpers/factories.js';
import { ago, issue, type World, world } from '../helpers/forecast-world.js';

const DAY_H = 24;

async function seed(
  projectId: string,
  ref: string,
  opts: {
    metadata?: object;
    written: Date;
    verified?: Date | null;
    source?: string;
    text?: string;
  },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO memories (project_id, source, source_ref, text_content, metadata, created_at, updated_at, last_verified_at)
    VALUES (${projectId}, ${opts.source ?? 'note'}, ${ref}, ${opts.text ?? `note ${ref}`},
            ${JSON.stringify(opts.metadata ?? {})}::jsonb, ${opts.written.toISOString()},
            ${opts.written.toISOString()}, ${opts.verified?.toISOString() ?? null})
  `);
}

async function rowOf(
  projectId: string,
  ref: string,
): Promise<{ archived: boolean; archivedBy: string | null }> {
  const [row] = (await db.execute(sql`
    SELECT archived_at IS NOT NULL AS archived, metadata->>'archivedBy' AS "archivedBy"
      FROM memories WHERE project_id = ${projectId} AND source_ref = ${ref}`)) as unknown as {
    archived: boolean;
    archivedBy: string | null;
  }[];
  if (!row) throw new Error(`no memory ${ref}`);
  return row;
}

/** The move's event, as the kernel emits it; the issue is seeded at the status it moved to. */
async function moved(w: World, issueId: string, from: string, to: 'closed' | 'dropped') {
  await emitEvent(db, 'issue.transitioned', {
    entity: 'issue',
    id: issueId,
    projectId: w.projectId,
    issueId,
    from: from as 'awaiting_release',
    to,
    machineVersion: 1,
    reason: null,
    actor: { type: 'user', id: w.userId, agency: 'agent' },
    at: new Date().toISOString(),
  });
  await settleOutbox(15_000);
}

beforeAll(async () => {
  testEnv();
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('a note written for an issue retires with it (criterion 1)', () => {
  let w: World;

  beforeAll(async () => {
    w = await world();
  }, 60_000);

  it('retires the notes naming the issue by id or key when it closes, and keeps one verified since', async () => {
    const done = await issue(w, {
      status: 'closed',
      createdAt: ago(10 * DAY_H),
      mergedAt: ago(1),
    });
    const other = await issue(w, { status: 'in_progress', createdAt: ago(10 * DAY_H) });
    await seed(w.projectId, 'by-id', { metadata: { issueId: done.id }, written: ago(48) });
    await seed(w.projectId, 'by-key', { metadata: { about: done.key }, written: ago(48) });
    await seed(w.projectId, 'checked', {
      metadata: { issueId: done.id },
      written: ago(48),
      verified: ago(1),
    });
    // checked, then rewritten: the body it holds now nobody checked
    await seed(w.projectId, 'rewritten', {
      metadata: { about: done.key },
      written: ago(2),
      verified: ago(10),
    });
    await seed(w.projectId, 'elsewhere', { metadata: { issueId: other.id }, written: ago(48) });
    await seed(w.projectId, 'fact', {
      source: 'knowledge',
      metadata: { issueId: done.id },
      written: ago(48),
    });

    await moved(w, done.id, 'awaiting_release', 'closed');

    for (const ref of ['by-id', 'by-key', 'rewritten']) {
      const row = await rowOf(w.projectId, ref);
      expect(row.archived, `${ref} stayed live after ${done.key} closed`).toBe(true);
      expect(row.archivedBy).toContain(done.key);
      expect(row.archivedBy).toContain('closed');
    }
    expect((await rowOf(w.projectId, 'checked')).archived, 'a note verified since retired').toBe(
      false,
    );
    expect((await rowOf(w.projectId, 'elsewhere')).archived).toBe(false);
    expect((await rowOf(w.projectId, 'fact')).archived, 'only notes retire').toBe(false);
  });

  it('retires them when the issue is dropped', async () => {
    const gone = await issue(w, { status: 'dropped', createdAt: ago(10 * DAY_H) });
    await seed(w.projectId, 'dropped-note', { metadata: { about: gone.key }, written: ago(48) });
    await moved(w, gone.id, 'open', 'dropped');
    const row = await rowOf(w.projectId, 'dropped-note');
    expect(row.archived).toBe(true);
    expect(row.archivedBy).toContain(`${gone.key}, which reached dropped`);
  });

  it('retires, on the next sweep, a note whose issue ended while nothing listened', async () => {
    const ended = await issue(w, {
      status: 'closed',
      createdAt: ago(10 * DAY_H),
      mergedAt: ago(DAY_H),
    });
    const open = await issue(w, { status: 'open', createdAt: ago(10 * DAY_H) });
    await seed(w.projectId, 'missed', { metadata: { issueId: ended.id }, written: ago(48) });
    await seed(w.projectId, 'still-open', { metadata: { about: open.key }, written: ago(48) });
    await runMemoryDecay();
    const missed = await rowOf(w.projectId, 'missed');
    expect(missed.archived).toBe(true);
    expect(missed.archivedBy).toContain(ended.key);
    expect((await rowOf(w.projectId, 'still-open')).archived).toBe(false);
  });
});

describe("a note naming no issue retires after the project's window unverified (criterion 2)", () => {
  it('retires one older than the window, keeps a younger one and one checked within it', async () => {
    const w = await world();
    const window = MEMORY_NOTE_WINDOW_DAYS;
    await seed(w.projectId, 'old', { written: ago((window + 1) * DAY_H) });
    await seed(w.projectId, 'young', { written: ago((window - 1) * DAY_H) });
    await seed(w.projectId, 'old-checked-lately', {
      written: ago((window + 6) * DAY_H),
      verified: ago(DAY_H),
    });
    await seed(w.projectId, 'old-checked-long-ago', {
      written: ago((window + 16) * DAY_H),
      verified: ago((window + 6) * DAY_H),
    });

    await runMemoryDecay();

    for (const ref of ['old', 'old-checked-long-ago']) {
      const row = await rowOf(w.projectId, ref);
      expect(row.archived, `${ref} outlived the window`).toBe(true);
      expect(row.archivedBy).toContain(`not verified in ${window} days`);
    }
    expect((await rowOf(w.projectId, 'young')).archived).toBe(false);
    expect((await rowOf(w.projectId, 'old-checked-lately')).archived).toBe(false);
  });

  it('reads the window from the project policy', async () => {
    const owner = await createTestUser({ verified: true });
    const { id: projectId } = await createTestProject(owner.id, {
      policy: { ...DEFAULT_POLICY, memory: { noteWindowDays: 30 } },
    });
    await seed(projectId, 'twenty-days', { written: ago(20 * DAY_H) });
    await seed(projectId, 'forty-days', { written: ago(40 * DAY_H) });
    await runMemoryDecay();
    expect((await rowOf(projectId, 'twenty-days')).archived).toBe(false);
    const old = await rowOf(projectId, 'forty-days');
    expect(old.archived).toBe(true);
    expect(old.archivedBy).toContain('not verified in 30 days');
  });
});

describe('a search hit carries its standing (criterion 3)', () => {
  it('labels a planted unverified note unverified and a checked one verified', async () => {
    const w = await world();
    await seed(w.projectId, 'planted', {
      text: 'The zephyrquartz board is flat.',
      written: ago(2),
    });
    await seed(w.projectId, 'checked', {
      text: 'The zephyrquartz board has eight columns.',
      written: ago(3),
      verified: ago(1),
    });
    await seed(w.projectId, 'checked-then-rewritten', {
      text: 'The zephyrquartz board keeps its order.',
      written: ago(1),
      verified: ago(3),
    });
    const res = await api(w.token, 'POST', '/api/memory/search', {
      projectId: w.projectId,
      query: 'zephyrquartz',
      strategy: 'keyword',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const hits = res.body.hits as { sourceRef: string; standing?: string }[];
    expect(hits).toHaveLength(3);
    const standing = Object.fromEntries(hits.map((h) => [h.sourceRef, h.standing]));
    expect(standing).toEqual({
      planted: 'unverified',
      checked: 'verified',
      'checked-then-rewritten': 'unverified',
    });
  });
});

describe('a decision is not a memory (criterion 4)', () => {
  it('refuses a new decision by name, naming the rule and requirement doors, and still reads the old ones', async () => {
    const w = await world();
    await seed(w.projectId, 'old-decision', {
      source: 'decision',
      text: 'We chose the flat board.',
      written: ago(DAY_H),
    });

    const res = await api(w.token, 'POST', '/api/memory', {
      projectId: w.projectId,
      source: 'decision',
      sourceRef: 'board-shape',
      textContent: 'We chose the flat board.',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const body = res.body as Body;
    expect(body.code).toBe('MEMORY_DECISION_NOT_MEMORY');
    const detail = String(body.detail);
    expect(detail).toContain('kind rule');
    expect(detail).toContain(`/api/projects/${w.projectId}/knowledge/<slug>`);
    expect(detail).toContain(`POST /api/projects/${w.projectId}/requirements`);
    const [counted] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM memories
       WHERE project_id = ${w.projectId} AND source = 'decision'`)) as unknown as { n: number }[];
    expect(counted?.n, 'the refused decision was written').toBe(1);

    const read = await api(w.token, 'GET', `/api/memory?projectId=${w.projectId}&source=decision`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(JSON.stringify(read.body)).toContain('old-decision');
  });
});
