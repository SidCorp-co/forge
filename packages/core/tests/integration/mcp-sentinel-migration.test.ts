/**
 * ISS-1071 — what the agent-access migration does, walked against a real Postgres.
 *
 * Every case is about a row's REACHABILITY before and after, never about whether a statement ran: a
 * grant this closes is a path somebody had, one it opens is a credential nobody offered. Two cases
 * are refusals, and beside each sits its boundary — the shape that must NOT abort — because an
 * over-broad abort is what crash-looped the beta API for 85 minutes on 0253, and a refusal with no
 * case proving where it stops is one nobody can trust to be narrow.
 *
 * The template database and the planting helpers are in `mcp-sentinel-migration.fixture.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  allConfigs,
  CUSTOM_SPEC,
  config,
  fresh,
  grantOf,
  ground,
  mapAt,
  plantBinding,
  plantProject,
  plantWide,
  runDown,
  runForward,
  type Wide,
} from './mcp-sentinel-migration.fixture.js';

describe('0259 forward — reachability is preserved row by row', () => {
  let w: Wide;

  beforeAll(async () => {
    w = await plantWide(await fresh());
    await runForward(w.f.sql);
  }, 120_000);

  afterAll(async () => {
    if (w) await w.f.drop();
  });

  it('grants a project-default sentinel over a live epodsystem credential', async () => {
    expect(await grantOf(w.f.sql, w.binding.shopEpod ?? '')).toBe('all');
  });

  it('grants a coolify binding that declared nothing, and says so in the deploy log', async () => {
    expect(await grantOf(w.f.sql, w.binding.coolify ?? '')).toBe('all');
    const forced = w.f.notices.filter((n) => /by FORCE/.test(n)).join('\n');
    expect(forced).toContain(w.binding.coolify ?? 'no-binding');
    expect(forced).toContain('deployer');
    expect(forced).toContain('coolify');
  });

  it('grants a google binding that declared nothing', async () => {
    expect(await grantOf(w.f.sql, w.binding.google ?? '')).toBe('all');
  });

  it('leaves a postman binding nobody declared closed', async () => {
    expect(await grantOf(w.f.sql, w.binding.postman ?? '')).toBe('none');
  });

  it('leaves a provider with no agent path closed', async () => {
    expect(await grantOf(w.f.sql, w.binding.rocketchat ?? '')).toBe('none');
    expect(await grantOf(w.f.sql, w.binding.github ?? '')).toBe('none');
  });

  it('accepts a stage-only sentinel over no binding, and removes it', async () => {
    expect(await mapAt(w.f.sql, w.project['stage-only'] ?? '', 'developed')).toBe('{}');
  });

  it('removes a per-stage `false`, and records it in the before-image', async () => {
    expect(await mapAt(w.f.sql, w.project['switched-off'] ?? '', 'testing')).toBe('{}');
    expect(await grantOf(w.f.sql, w.binding.switchedOffPostman ?? '')).toBe('none');
    const rows = await w.f.sql.unsafe(
      `SELECT scope, server_name, value::text AS v FROM iss1071_removed_mcp_sentinels
        WHERE project_id = $1`,
      [w.project['switched-off'] ?? ''],
    );
    expect(rows.map((r) => `${r.scope}/${r.server_name}=${r.v}`)).toEqual([
      'testing/postman=false',
    ]);
  });

  it('grants and removes an `epodsystem_<label>` sentinel', async () => {
    expect(await grantOf(w.f.sql, w.binding.storeA ?? '')).toBe('all');
    expect(await mapAt(w.f.sql, w.project['two-stores'] ?? '', 'default')).toBe('{}');
  });

  it('leaves a catalog name and every object spec alone, including one named `postman`', async () => {
    const stored = await mapAt(w.f.sql, w.project.custom ?? '', 'default');
    expect(JSON.parse(stored ?? 'null')).toEqual({
      playwright: true,
      'my-own-server': CUSTOM_SPEC,
      postman: CUSTOM_SPEC,
    });
    expect(await grantOf(w.f.sql, w.binding.customPostman ?? '')).toBe('none');
  });
});

describe('0259 forward — what it refuses, and where the refusal stops', () => {
  it('aborts naming a provider its vocabulary does not classify', async () => {
    const f = await fresh();
    try {
      const g = await ground(f.sql);
      const projectId = await plantProject(f.sql, g, 'newcomer', config(null));
      await plantBinding(f.sql, g, { projectId, provider: 'linear' });

      await expect(runForward(f.sql)).rejects.toThrow(/linear/);

      const cols = await f.sql.unsafe(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'integration_bindings'`,
      );
      expect(cols.map((c) => c.column_name as string)).not.toContain('agent_access');
    } finally {
      await f.drop();
    }
  });

  it('aborts naming the project and provider of a per-stage grant it cannot represent', async () => {
    const f = await fresh();
    try {
      const g = await ground(f.sql);
      const projectId = await plantProject(
        f.sql,
        g,
        'scoped-lane',
        config(null, { developed: { sentry: true } }),
      );
      await plantBinding(f.sql, g, { projectId, provider: 'sentry' });

      const err = await runForward(f.sql).then(
        () => null,
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
      expect(err).toMatch(/scoped-lane/);
      expect(err).toMatch(/sentry/);
      expect(err).toMatch(/developed/);
    } finally {
      await f.drop();
    }
  });

  it.each([
    ['the binding is inactive', { active: false }],
    ['the connection is inactive', { connectionActive: false }],
    ['the connection holds no credential', { credential: false }],
  ])('does not abort on a per-stage grant where %s', async (_name, flags) => {
    const f = await fresh();
    try {
      const g = await ground(f.sql);
      const projectId = await plantProject(
        f.sql,
        g,
        'dormant',
        config(null, { developed: { sentry: true } }),
      );
      const bindingId = await plantBinding(f.sql, g, {
        projectId,
        provider: 'sentry',
        ...flags,
      });

      await runForward(f.sql);

      expect(await grantOf(f.sql, bindingId)).toBe('none');
      expect(await mapAt(f.sql, projectId, 'developed')).toBe('{}');
    } finally {
      await f.drop();
    }
  });

  it('does not abort where the project default declares the same provider', async () => {
    const f = await fresh();
    try {
      const g = await ground(f.sql);
      const projectId = await plantProject(
        f.sql,
        g,
        'default-and-stage',
        config({ sentry: true }, { developed: { sentry: true } }),
      );
      const bindingId = await plantBinding(f.sql, g, { projectId, provider: 'sentry' });

      await runForward(f.sql);

      expect(await grantOf(f.sql, bindingId)).toBe('all');
      expect(await mapAt(f.sql, projectId, 'default')).toBe('{}');
      expect(await mapAt(f.sql, projectId, 'developed')).toBe('{}');
    } finally {
      await f.drop();
    }
  });
});

describe('0259_down.sql — the way back', () => {
  it('restores every stored map to exactly what the forward run found', async () => {
    const f = await fresh();
    try {
      const w = await plantWide(f);
      const before = await allConfigs(f.sql);

      await runForward(f.sql);
      const stripped = await allConfigs(f.sql);
      // The rollback is only worth proving if the forward run moved something.
      expect(stripped).not.toEqual(before);
      expect(await grantOf(f.sql, w.binding.shopEpod ?? '')).toBe('all');

      await runDown(f.sql);

      expect(await allConfigs(f.sql)).toEqual(before);
      const cols = await f.sql.unsafe(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'integration_bindings'`,
      );
      expect(cols.map((c) => c.column_name as string)).not.toContain('agent_access');
    } finally {
      await f.drop();
    }
  }, 120_000);

  // F2, found by review. Refusal 1 asks whether a grant moved AWAY from what 0259 set, and a
  // binding created afterwards has no image row, so its `none` matches the default baseline and
  // reads as a pass. It is the opposite of safe: the old model gates direct-MCP per PROJECT and
  // does not gate core-mediated at all, so going back ADDS access to a row somebody deliberately
  // closed — silently, with the column dropped and nothing left to show it was ever closed.
  it.each([
    ['google', 'core-mediated: ungated once the column is gone'],
    ['epodsystem', "direct-mcp: the project's restored sentinel re-enables its whole active set"],
  ])(
    'refuses a denied %s binding created after the forward run',
    async (provider) => {
      const f = await fresh();
      try {
        const g = await ground(f.sql);
        // The seed binding exists only so the forward run has a sentinel to strip and the rollback
        // has something to restore; it is `postman` so the late binding below, which is the subject,
        // does not collide with it on `integration_bindings_service_uq`.
        const projectId = await plantProject(f.sql, g, 'new-denial', config({ postman: true }));
        await plantBinding(f.sql, g, { projectId, provider: 'postman' });

        await runForward(f.sql);
        const stripped = await allConfigs(f.sql);
        // Created AFTER the forward run, so it has no row in the image table, and left closed.
        const lateId = await plantBinding(f.sql, g, { projectId, provider });
        expect(await grantOf(f.sql, lateId)).toBe('none');

        const err = await runDown(f.sql).then(
          () => null,
          (e: unknown) => (e instanceof Error ? e.message : String(e)),
        );
        expect(err).toMatch(new RegExp(lateId));
        expect(err).toMatch(/new-denial/);

        const cols = await f.sql.unsafe(
          `SELECT column_name FROM information_schema.columns WHERE table_name = 'integration_bindings'`,
        );
        expect(cols.map((c) => c.column_name as string)).toContain('agent_access');
        expect(await allConfigs(f.sql)).toEqual(stripped);
      } finally {
        await f.drop();
      }
    },
    120_000,
  );

  // The refusal advertises two ways out, so both are walked: a refusal whose escape does not clear
  // it teaches an operator to reach for the escape that always works, which is deleting the check.
  it('clears once the denied binding is deactivated, which is what it tells you to do', async () => {
    const f = await fresh();
    try {
      const g = await ground(f.sql);
      const projectId = await plantProject(f.sql, g, 'deactivated', config({ postman: true }));
      await plantBinding(f.sql, g, { projectId, provider: 'postman' });
      await runForward(f.sql);
      const lateId = await plantBinding(f.sql, g, { projectId, provider: 'google' });

      const refused = await runDown(f.sql).then(
        () => null,
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
      expect(refused).toMatch(new RegExp(lateId));

      await f.sql.unsafe(`UPDATE integration_bindings SET active = false WHERE id = $1`, [lateId]);

      await runDown(f.sql);
      const cols = await f.sql.unsafe(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'integration_bindings'`,
      );
      expect(cols.map((c) => c.column_name as string)).not.toContain('agent_access');
    } finally {
      await f.drop();
    }
  }, 120_000);

  // A provider with no agent path at all was never reachable, so going back grants it nothing and
  // 1b must let it through — otherwise the refusal is a blanket "any new binding" and an operator
  // learns to wave it away, which is how a real denial gets waved away with it.
  it('lets a denied binding of a provider with no agent path roll back', async () => {
    const f = await fresh();
    try {
      const g = await ground(f.sql);
      const projectId = await plantProject(f.sql, g, 'no-path', config({ postman: true }));
      await plantBinding(f.sql, g, { projectId, provider: 'postman' });
      await runForward(f.sql);
      const lateId = await plantBinding(f.sql, g, { projectId, provider: 'github' });
      expect(await grantOf(f.sql, lateId)).toBe('none');

      await runDown(f.sql);

      const cols = await f.sql.unsafe(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'integration_bindings'`,
      );
      expect(cols.map((c) => c.column_name as string)).not.toContain('agent_access');
    } finally {
      await f.drop();
    }
  }, 120_000);

  it('refuses by name, changing nothing, when a grant moved after the forward run', async () => {
    const f = await fresh();
    try {
      const g = await ground(f.sql);
      const projectId = await plantProject(f.sql, g, 'moved-on', config({ postman: true }));
      const bindingId = await plantBinding(f.sql, g, { projectId, provider: 'postman' });

      await runForward(f.sql);
      expect(await grantOf(f.sql, bindingId)).toBe('all');
      const stripped = await allConfigs(f.sql);

      await f.sql.unsafe(`UPDATE integration_bindings SET agent_access = 'none' WHERE id = $1`, [
        bindingId,
      ]);

      const err = await runDown(f.sql).then(
        () => null,
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
      expect(err).toMatch(new RegExp(bindingId));
      expect(err).toMatch(/moved-on/);
      expect(err).toMatch(/postman/);

      // changed nothing: the column is still there and the map is still stripped
      const cols = await f.sql.unsafe(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'integration_bindings'`,
      );
      expect(cols.map((c) => c.column_name as string)).toContain('agent_access');
      expect(await allConfigs(f.sql)).toEqual(stripped);
    } finally {
      await f.drop();
    }
  });
});
