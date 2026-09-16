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

describe('0255 forward — reachability is preserved row by row', () => {
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

  // cm:guard `none` here would not preserve a state, it would TAKE AWAY a path that is open:
  // `forge_coolify_deploy` answers any project member's agent today with nothing to read.
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

  // cm:guard the BOUNDARY of section 5's abort. Nothing was reachable — no binding at all —
  // so `none` is exactly what was true and the sentinel is simply removed. An abort here
  // would be the over-broad abort that crash-loops a deploy.
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

  // cm:guard only a literal boolean is the shorthand. An object under an integration name is
  // a custom server somebody hand-wrote — `isIntegrationSentinelName` is about the NAME, and
  // reading the name alone would delete a working server spec and grant on it at once.
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

describe('0255 forward — what it refuses, and where the refusal stops', () => {
  // cm:guard the refusal IS the deliverable. There is no safe default for a provider whose
  // agent path this file cannot read: `none` silently closes a path that is open, `all`
  // silently writes a credential onto a runner box.
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

  // cm:guard the one shape a binary column cannot hold: the credential reaches ONE stage
  // today. `all` widens a live credential to stages that never had it; `none` breaks a lane
  // somebody is working in. Neither is preservation, so the migration stops and asks.
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

  // cm:guard the same stage-only sentinel, one flag at a time off the binding. Each of these
  // is a lane that is NOT open today, so nothing is taken away by leaving the grant closed —
  // and an abort that fired on any of them would be the over-broad abort 0253 paid for.
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

  // cm:guard a project default beside the stage declaration is NOT the unrepresentable shape:
  // the project already opts in everywhere, so `all` is what is true and the stage entry adds
  // nothing a column has to carry.
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

describe('0255_down.sql — the way back', () => {
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

  // cm:guard the image is a photograph of one moment, and a grant changed since is a decision
  // it cannot speak for: the map it would restore is not the state that grant came from, and
  // the column is about to be dropped, so nothing would record that the decision existed.
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
