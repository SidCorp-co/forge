/**
 * ISS-1336 end to end, the ranking: a backlog ordering is read from stored scores, and the changes
 * to its inputs keep them current, over a real database and a real socket.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  catchUp,
  cliTotal,
  computedAt,
  configService,
  harness,
  keyOf,
  maintainer,
  pendingRows,
  projectId,
  ranking,
  resetKit,
  seedFixtureBacklog,
  seedIssue,
  startKit,
  stopKit,
} from '../helpers/backlog-index-kit.js';

beforeAll(startKit, 180_000);
afterAll(stopKit);
beforeEach(resetKit);

describe('the ranking read', () => {
  it('serves what the CLI computes, from rows stored before the call, ties on the filing date', async () => {
    const { ids, expected } = await seedFixtureBacklog();
    await catchUp();

    const { status, body } = await ranking('?catchUpMs=0');

    expect(status).toBe(200);
    // A 56, C 54, B 44, E 37, F 34, I 31 (filed 21 days ago), G 31 (5 days ago), D 21 — the tie
    // between I and G goes to the older filing.
    const order = ['A', 'C', 'B', 'E', 'F', 'I', 'G', 'D'];
    expect(body.order.map((r) => keyOf(ids, r.issueId))).toEqual(order);
    for (const row of body.order) {
      const key = keyOf(ids, row.issueId);
      expect(row.score.total, `total of ${key}`).toBe(expected[key]);
      expect(row.score.parts.reduce((sum, p) => sum + p.points, 0)).toBe(row.score.total);
      expect(row.score.parts.map((p) => p.name)).toEqual([
        'priority',
        'kind',
        'complexity',
        'module',
        'age',
        'reopened',
        'blocks',
      ]);
    }
    expect(body.takeable).toBe(8);
    expect(body.index).toMatchObject({ state: 'fresh', pending: 0, lapsed: 0 });
    expect(body.edges).toBe('tracker');
    expect(body.excluded.map((e) => e.term)).toEqual(['reading', 'prose edges']);
  });

  it('computes no score on a read when nothing is pending', async () => {
    await seedFixtureBacklog();
    await catchUp();
    const before = await computedAt();

    const { body } = await ranking();

    expect(body.index.state).toBe('fresh');
    expect(await computedAt()).toEqual(before);
  });

  it('carries no body and no label on a row, only the score and what is blocked and leased', async () => {
    await seedFixtureBacklog();
    await catchUp();
    const { body } = await ranking();
    for (const row of body.order) {
      expect(Object.keys(row).sort()).toEqual(
        [
          'blockedBy',
          'category',
          'chained',
          'complexity',
          'createdAt',
          'displayId',
          'eligible',
          'issueId',
          'lease',
          'priority',
          'score',
          'status',
          'title',
        ].sort(),
      );
    }
  });
});

describe('what a change recomputes', () => {
  it('rescores the changed issue and the issues above it in a chain, and no other', async () => {
    const { ids } = await seedFixtureBacklog();
    await catchUp();
    const before = await computedAt();

    await harness.db.execute(sql`UPDATE issues SET priority = 'critical' WHERE id = ${ids.G}`);
    const result = await maintainer.drainRank(projectId);

    expect(result.outcome).toBe('drained');
    // G holds nothing up, F holds G up, E holds F up: the chain is the three of them.
    expect(new Set(result.rescored)).toEqual(new Set([ids.G, ids.F, ids.E]));
    const after = await computedAt();
    for (const [key, id] of Object.entries(ids)) {
      if (['E', 'F', 'G'].includes(key) || !(id in before)) continue;
      expect(after[id], `${key} untouched`).toBe(before[id]);
    }
    const { body } = await ranking('?catchUpMs=0');
    expect(body.order.find((r) => r.issueId === ids.G)?.score.total).toBe(
      cliTotal({
        priority: 'critical',
        category: 'feature',
        complexity: 's',
        reopen: 0,
        days: 5,
        chain: 0,
      }),
    );
  });

  it('rescores an issue alone when nothing waits on it, whichever input moved', async () => {
    const { ids } = await seedFixtureBacklog();
    await catchUp();

    for (const change of [
      sql`UPDATE issues SET complexity = 'xl' WHERE id = ${ids.A}`,
      sql`UPDATE issues SET category = 'enhancement' WHERE id = ${ids.A}`,
      sql`UPDATE issues SET reopen_count = 3 WHERE id = ${ids.A}`,
      sql`UPDATE issues SET status = 'confirmed' WHERE id = ${ids.A}`,
    ]) {
      await harness.db.execute(change);
      const result = await maintainer.drainRank(projectId);
      expect(result.rescored, 'one issue').toEqual([ids.A]);
    }
    const { body } = await ranking('?catchUpMs=0');
    expect(body.order.find((r) => r.issueId === ids.A)?.score.total).toBe(
      cliTotal({
        priority: 'high',
        category: 'enhancement',
        complexity: 'xl',
        reopen: 3,
        days: 10,
        chain: 0,
      }),
    );
  });

  it('drops the row of an issue that left the takeable set, and adds one that entered', async () => {
    const { ids } = await seedFixtureBacklog();
    await catchUp();

    await harness.db.execute(sql`UPDATE issues SET status = 'in_progress' WHERE id = ${ids.D}`);
    await harness.db.execute(sql`UPDATE issues SET status = 'open' WHERE id = ${ids.IN_PROGRESS}`);
    const result = await maintainer.drainRank(projectId);

    expect(result.removed).toEqual([ids.D]);
    expect(result.rescored).toEqual([ids.IN_PROGRESS]);
    const { body } = await ranking('?catchUpMs=0');
    expect(body.order.map((r) => r.issueId)).not.toContain(ids.D);
    expect(body.order.map((r) => r.issueId)).toContain(ids.IN_PROGRESS);
  });

  it('rescores an issue whose primary module changed', async () => {
    const { ids } = await seedFixtureBacklog();
    await catchUp();
    const module = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO labels (id, project_id, name, color, kind, slug)
      VALUES (${module}, ${projectId}, 'core', '#000000', 'module', 'core')`);
    await harness.db.execute(sql`
      INSERT INTO issue_labels (issue_id, label_id, is_primary) VALUES (${ids.A}, ${module}, true)`);

    const result = await maintainer.drainRank(projectId);

    expect(result.rescored).toEqual([ids.A]);
  });

  it('rescores every takeable issue when a weight changes', async () => {
    const { ids } = await seedFixtureBacklog();
    await catchUp();

    await configService.updatePipelineConfig({
      projectId,
      patch: { rank: { priority: { high: 35 } } },
      base: {},
    });
    const result = await maintainer.drainRank(projectId);

    expect(result.rescored.sort()).toEqual(
      Object.entries(ids)
        .filter(([key]) => key !== 'IN_PROGRESS')
        .map(([, id]) => id)
        .sort(),
    );
  });
});

describe('what the read says about an index that is behind', () => {
  it('names a change made by raw SQL as pending until it is caught up', async () => {
    const { ids } = await seedFixtureBacklog();
    await catchUp();

    await harness.db.execute(sql`UPDATE issues SET priority = 'critical' WHERE id = ${ids.A}`);
    const stale = await ranking('?catchUpMs=0');

    expect(stale.status).toBe(200);
    expect(stale.body.index.state).toBe('stale');
    expect(stale.body.index.pending).toBeGreaterThanOrEqual(1);
    expect(Date.parse(stale.body.index.oldestPendingAt as string)).toBeLessThanOrEqual(Date.now());

    const caught = await ranking();
    expect(caught.body.index).toMatchObject({ state: 'fresh', pending: 0 });
    expect(caught.body.order.find((r) => r.issueId === ids.A)?.score.total).toBe(
      cliTotal({
        priority: 'critical',
        category: 'bug',
        complexity: 'xs',
        reopen: 0,
        days: 10,
        chain: 0,
      }),
    );
  });

  it('refuses by name when a takeable issue has no score, and serves no ordering', async () => {
    const { ids } = await seedFixtureBacklog();
    await catchUp();
    await harness.db.execute(sql`DELETE FROM issue_rank_scores WHERE issue_id = ${ids.B}`);

    const refused = await ranking('?catchUpMs=0');

    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('RANK_INDEX_INCOMPLETE');
    expect(refused.body.message).toMatch(/1 of 8 takeable/);
    expect(refused.body.details).toMatchObject({ unscored: 1, issues: ['ISS-2'] });
    expect(refused.body).not.toHaveProperty('order');
  });

  it('brings an uncovered index up to date in the read that finds it', async () => {
    const { ids } = await seedFixtureBacklog();
    await catchUp();
    await harness.db.execute(sql`DELETE FROM issue_rank_scores WHERE issue_id = ${ids.B}`);
    await harness.db.execute(sql`DELETE FROM backlog_index_dirty WHERE project_id = ${projectId}`);

    const healed = await ranking();

    expect(healed.status).toBe(200);
    expect(healed.body.order.map((r) => r.issueId)).toContain(ids.B);
    expect(healed.body.index.state).toBe('fresh');
  });

  it('refuses over a backlog nothing has scored yet, naming every issue it is short of', async () => {
    await seedFixtureBacklog();
    const refused = await ranking('?catchUpMs=0');
    expect(refused.status).toBe(409);
    expect(refused.body.details).toMatchObject({ takeable: 8, unscored: 8 });
  });
});

describe('what one read is allowed to see', () => {
  it('answers from one snapshot, so a commit in the middle of a read cannot split it', async () => {
    await seedFixtureBacklog();
    await catchUp();
    const dirty = await import('../../src/issues/backlog/index-dirty.js');
    const original = dirty.pendingFor;
    const spy = vi.spyOn(dirty, 'pendingFor').mockImplementation(async (...args) => {
      const seen = await original(...args);
      await seedIssue(99, { title: 'filed mid read' });
      return seen;
    });
    try {
      const { status, body } = await ranking('?catchUpMs=0');
      expect(status).toBe(200);
      // A count that includes an issue the order lacks, beside an index reported fresh, is the
      // split this refuses: every statement of the read sees the moment the first one did.
      expect(body.takeable).toBe(body.order.length);
      expect(body.index.state).toBe('fresh');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('a project that is deleted', () => {
  it('goes with its issues, its scores and its marks, and the cascade raises no foreign key error', async () => {
    await seedFixtureBacklog();
    await catchUp();

    await harness.db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);

    for (const table of ['backlog_index_dirty', 'issue_rank_scores', 'issue_alike_seeds']) {
      const [row] = await harness.db.execute(
        sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE project_id = ${projectId}`,
      );
      expect((row as { n: number }).n, table).toBe(0);
    }
  });
});

describe('the migration on a populated database', () => {
  it('marks every project whole for both indexes, so the first pass covers what exists', async () => {
    // The backfill is the migration's own last statement, read from the file and run here, not a copy.
    const file = readFileSync(
      new URL(
        '../../drizzle/migrations/0327_a_backlog_ordering_is_held_between_calls.sql',
        import.meta.url,
      ),
      'utf8',
    );
    const backfill = file
      .split('--> statement-breakpoint')
      .find((one) => one.includes('migration 0327 backfill'));
    expect(backfill).toBeDefined();

    await seedFixtureBacklog();
    await harness.db.execute(sql`DELETE FROM backlog_index_dirty`);
    await harness.db.execute(sql`DELETE FROM issue_rank_scores`);
    await harness.db.execute(sql.raw(backfill as string));

    expect(await pendingRows('rank', 'alike-seed')).toBe(2);
    const first = await maintainer.drainRank(projectId);
    expect(first.outcome).toBe('drained');
    expect(first.rescored).toHaveLength(8);
    expect(await pendingRows()).toBe(0);
    expect((await ranking('?catchUpMs=0')).status).toBe(200);
  });
});
