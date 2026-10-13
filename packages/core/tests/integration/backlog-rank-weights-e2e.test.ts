/**
 * ISS-1336 end to end, the weights and the live facts: where a project's weight table lives, what
 * an edge that lapses does, and what is blocked and leased at the moment of the read.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  catchUp,
  cliTotal,
  configService,
  edge,
  harness,
  PRIORITY,
  projectId,
  ranking,
  resetKit,
  rows,
  seedFixtureBacklog,
  seedIssue,
  server,
  startKit,
  stopKit,
  userId,
} from '../helpers/backlog-index-kit.js';

beforeAll(startKit, 180_000);
afterAll(stopKit);
beforeEach(resetKit);

describe('where the weights live', () => {
  it('names the built-in table where the project stored none', async () => {
    await seedFixtureBacklog();
    await catchUp();
    const { body } = await ranking();
    expect(body.weights.from).toBe('built-in');
    expect(body.weights.value).toMatchObject({
      priority: PRIORITY,
      reopened: 5,
      blocks: 3,
      agePerDay: 1,
    });
  });

  it('applies one overridden weight, names the project, and leaves every other weight alone', async () => {
    const { ids } = await seedFixtureBacklog();
    await catchUp();
    await configService.updatePipelineConfig({
      projectId,
      patch: { rank: { priority: { high: 35 }, blocks: 10 } },
      base: {},
    });

    const { body } = await ranking();

    expect(body.weights.from).toBe('project');
    const value = body.weights.value as {
      priority: Record<string, number>;
      blocks: number;
      reopened: number;
    };
    expect(value.priority).toEqual({ ...PRIORITY, high: 35 });
    expect(value.blocks).toBe(10);
    expect(value.reopened).toBe(5);
    const a = body.order.find((r) => r.issueId === ids.A);
    expect(a?.score.total).toBe(
      cliTotal({
        priority: 'high',
        category: 'bug',
        complexity: 'xs',
        reopen: 0,
        days: 10,
        chain: 0,
      }) + 5,
    );
    const e = body.order.find((r) => r.issueId === ids.E);
    expect(e?.score.total).toBe(
      cliTotal({
        priority: 'medium',
        category: 'feature',
        complexity: 's',
        reopen: 0,
        days: 5,
        chain: 2,
      }) +
        2 * 7,
    );
  });

  it('never serves a score computed under the old weights as fresh', async () => {
    await seedFixtureBacklog();
    await catchUp();
    await configService.updatePipelineConfig({
      projectId,
      patch: { rank: { priority: { high: 35 } } },
      base: {},
    });

    const behind = await ranking('?catchUpMs=0');

    expect(behind.status).toBe(409);
    expect(behind.body.code).toBe('RANK_INDEX_INCOMPLETE');
    expect(behind.body.details).toMatchObject({ underPreviousWeights: 8 });
    expect((await ranking()).body.index.state).toBe('fresh');
  });

  it('applies an age weight at read, so a changed age weight needs no rescore', async () => {
    const { ids } = await seedFixtureBacklog();
    await catchUp();
    await configService.updatePipelineConfig({
      projectId,
      patch: { rank: { agePerDay: 2, ageCap: 15 } },
      base: {},
    });

    const { body } = await ranking('?catchUpMs=0');

    expect(body.index.state).toBe('stale');
    const c = body.order.find((r) => r.issueId === ids.C);
    // 30 days at 2 a day is 60, capped at 15.
    expect(c?.score.parts.find((p) => p.name === 'age')).toMatchObject({ said: '30d', points: 15 });
  });

  it('refuses a rank key that names no weight, and the two that retired, with nothing stored', async () => {
    for (const [key, value, said] of [
      ['windowCap', 12, /windowCap.*retired/],
      ['readCap', 100, /readCap.*retired/],
      ['nonsense', 1, /rank\.nonsense.*no weight of this table/],
    ] as const) {
      await expect(
        configService.updatePipelineConfig({
          projectId,
          patch: { rank: { [key]: value } },
          base: {},
        }),
      ).rejects.toThrow(said);
    }
    await expect(
      configService.updatePipelineConfig({
        projectId,
        patch: { rank: { priority: { urgent: 50 } } },
        base: {},
      }),
    ).rejects.toThrow(/rank\.priority\.urgent.*no row of that table/);
    const [row] = await rows<{ rank: unknown }>(
      sql`SELECT agent_config #> '{pipelineConfig,rank}' AS rank FROM projects WHERE id = ${projectId}`,
    );
    expect(row?.rank ?? null).toBeNull();
  });

  it('refuses the read by name when rank.module weighs a module the project does not define', async () => {
    await seedFixtureBacklog();
    await catchUp();
    await configService.updatePipelineConfig({
      projectId,
      patch: { rank: { module: { ghost: 4 } } },
      base: {},
    });

    const refused = await ranking();

    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('RANK_WEIGHTS_REFUSED');
    expect(refused.body.message).toMatch(/`ghost`.*no module/);
    expect(refused.body).not.toHaveProperty('order');
  });

  it('weighs a module by its own row, or the nearest ancestor that has one', async () => {
    const { ids } = await seedFixtureBacklog();
    const parent = randomUUID();
    const child = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO labels (id, project_id, name, color, kind, slug) VALUES
        (${parent}, ${projectId}, 'core', '#000000', 'module', 'core')`);
    await harness.db.execute(sql`
      INSERT INTO labels (id, project_id, name, color, kind, slug, parent_id) VALUES
        (${child}, ${projectId}, 'core-jobs', '#000000', 'module', 'core-jobs', ${parent})`);
    await harness.db.execute(sql`
      INSERT INTO issue_labels (issue_id, label_id, is_primary) VALUES
        (${ids.A}, ${parent}, true), (${ids.B}, ${child}, true)`);
    await configService.updatePipelineConfig({
      projectId,
      patch: { rank: { module: { core: 7 } } },
      base: {},
    });

    const { body } = await ranking();

    const moduleOf = (id: string | undefined) =>
      body.order.find((r) => r.issueId === id)?.score.parts.find((p) => p.name === 'module');
    expect(moduleOf(ids.A)).toMatchObject({ said: 'core', points: 7 });
    expect(moduleOf(ids.B)).toMatchObject({ said: "core-jobs (core's row)", points: 7 });
    expect(moduleOf(ids.C)).toMatchObject({ said: 'none (unset)', points: 0 });
  });
});

describe('a lapsed edge', () => {
  it('drops the chained term with no write, and is named stale until recomputed', async () => {
    const a = await seedIssue(1, { priority: 'medium', complexity: 'm' });
    const b = await seedIssue(2, { priority: 'medium', complexity: 'm' });
    await edge(a, b, { validUntil: new Date(Date.now() + 2_500).toISOString() });
    await catchUp();
    const held = (await ranking('?catchUpMs=0')).body.order.find((r) => r.issueId === a);
    expect(held?.chained).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const stale = await ranking('?catchUpMs=0');
    expect(stale.body.index.state).toBe('stale');
    expect(stale.body.index.lapsed).toBe(1);

    const caught = await ranking();
    const row = caught.body.order.find((r) => r.issueId === a);
    expect(row?.chained).toBe(0);
    expect(row?.score.total).toBe((held?.score.total as number) - 3);
    expect(caught.body.index).toMatchObject({ state: 'fresh', lapsed: 0 });
  }, 20_000);
});

describe('what is eligible and what is leased', () => {
  it('names a blocked issue with its blockers, and frees it when its blocker reaches a releasing status', async () => {
    const blocker = await seedIssue(1, { priority: 'low' });
    const held = await seedIssue(2, { priority: 'critical' });
    await edge(blocker, held);
    await catchUp();

    let body = (await ranking('?catchUpMs=0')).body;
    const row = body.order.find((r) => r.issueId === held);
    expect(row).toMatchObject({ eligible: false });
    expect(row?.blockedBy).toMatchObject([
      { displayId: 'ISS-1', status: 'open', holdsUntil: 'settled' },
    ]);
    expect(body.eligible).toBe(1);
    expect(body.takeable).toBe(2);
    expect((await ranking('?eligible=true&catchUpMs=0')).body.order.map((r) => r.issueId)).toEqual([
      blocker,
    ]);

    await harness.db.execute(sql`UPDATE issues SET status = 'developed' WHERE id = ${blocker}`);
    body = (await ranking('?catchUpMs=0')).body;
    expect(body.order.find((r) => r.issueId === held)).toMatchObject({
      eligible: true,
      blockedBy: [],
    });
  });

  it('holds an issue behind a shipped edge until the blocker is closed, not merely awaiting release', async () => {
    const blocker = await seedIssue(1, { status: 'awaiting_release' });
    const held = await seedIssue(2);
    await edge(blocker, held, { holds: 'shipped' });
    await catchUp();

    const row = (await ranking('?catchUpMs=0')).body.order.find((r) => r.issueId === held);

    expect(row).toMatchObject({ eligible: false });
    expect(row?.blockedBy).toMatchObject([{ status: 'awaiting_release', holdsUntil: 'shipped' }]);
  });

  it('does not hold an issue behind an edge that has lapsed or is not a blocking kind', async () => {
    const a = await seedIssue(1);
    const b = await seedIssue(2);
    const c = await seedIssue(3);
    await edge(a, b, { validUntil: new Date(Date.now() - 60_000).toISOString() });
    await harness.db.execute(sql`
      INSERT INTO issue_dependencies (id, project_id, from_issue_id, to_issue_id, kind)
      VALUES (${randomUUID()}, ${projectId}, ${a}, ${c}, 'relates')`);
    await catchUp();

    const body = (await ranking('?catchUpMs=0')).body;

    expect(body.order.filter((r) => !r.eligible)).toEqual([]);
    expect(body.order.every((r) => r.chained === 0)).toBe(true);
  });

  it('reports a lease on its row and keeps the row in the answer', async () => {
    const leased = await seedIssue(1);
    const quiet = await seedIssue(2);
    await harness.db.execute(sql`
      UPDATE issues SET session_context = jsonb_build_object('lease', jsonb_build_object(
        'holder', 'iss-1-abc', 'renewedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'minutes', 30))
      WHERE id = ${leased}`);
    await catchUp();

    const body = (await ranking('?catchUpMs=0')).body;

    expect(body.order.find((r) => r.issueId === leased)?.lease).toMatchObject({
      holder: 'iss-1-abc',
      live: true,
    });
    expect(body.order.find((r) => r.issueId === quiet)?.lease).toBeNull();
    expect(body.order).toHaveLength(2);
  });

  it('agrees with the master set on every edge shape', async () => {
    // One dependent per shape, all `confirmed`, which the project admits to the master's set.
    await harness.db.execute(sql`
      UPDATE projects SET agent_config = ${JSON.stringify({
        pipelineConfig: { enabled: true, poolBacklog: { statuses: ['confirmed'], limit: 100 } },
      })}::jsonb WHERE id = ${projectId}`);
    const shapes: Array<{ name: string; blocker: string; holds: string; lapsed: boolean }> = [];
    for (const blocker of [
      'open',
      'in_progress',
      'developed',
      'testing',
      'awaiting_release',
      'closed',
      'dropped',
    ]) {
      for (const holds of ['settled', 'shipped']) {
        for (const lapsed of [false, true])
          shapes.push({ name: `${blocker}/${holds}/${lapsed}`, blocker, holds, lapsed });
      }
    }
    const dependents = new Map<string, string>();
    let seq = 1;
    for (const shape of shapes) {
      const blockerId = randomUUID();
      await harness.db.execute(sql`
        INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at)
        VALUES (${blockerId}, ${projectId}, ${seq++}, ${`blocker ${shape.name}`}, ${shape.blocker}, ${userId},
                CASE WHEN ${shape.blocker} = 'closed' THEN now() END)`);
      const dependent = await seedIssue(seq++, {
        status: 'confirmed',
        title: `dependent ${shape.name}`,
      });
      dependents.set(dependent, shape.name);
      await edge(blockerId, dependent, {
        holds: shape.holds,
        ...(shape.lapsed ? { validUntil: new Date(Date.now() - 60_000).toISOString() } : {}),
      });
    }
    await catchUp();

    const { pairDevice } = await import('../helpers/pair-device.js');
    const issued = await pairDevice({ ownerId: userId, name: 'parity-box', platform: 'linux' });
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, device_id, name, type, status)
      VALUES (${randomUUID()}, ${projectId}, ${issued.device.id}, 'parity-runner', 'claude-code', 'online')`);
    const res = await fetch(`${server.baseUrl}/api/devices/me/issues/admissible`, {
      headers: { authorization: `Bearer ${issued.plaintext}` },
    });
    expect(res.status).toBe(200);
    const masterSet = new Set(
      ((await res.json()) as { items: Array<{ title: string }> }).items.map((i) => i.title),
    );

    const mine = (await ranking('?catchUpMs=0&limit=500')).body.order.filter((r) =>
      dependents.has(r.issueId),
    );
    expect(mine).toHaveLength(shapes.length);
    for (const row of mine) {
      const title = `dependent ${dependents.get(row.issueId)}`;
      expect(row.eligible, dependents.get(row.issueId)).toBe(masterSet.has(title));
    }
  }, 60_000);
});
