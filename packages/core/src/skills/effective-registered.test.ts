/**
 * ISS-1025 — `resolveRegisteredEffectiveSkills` asks the database for the
 * skills it will return, and no others.
 *
 * This is a BODY projection (`skill_md`, `prompt`, the base64 `files`) and
 * every row it loads is sha256'd by `computeEffectiveSkill`, so the filter has
 * to be the WHERE rather than a `.filter()` over loaded rows: `POST
 * /api/skills/sync-status` used to transfer and hash every skill a project
 * owns to keep the few that are registered. What the query ASKS for is the
 * claim here — a returned set proves nothing, since an in-memory filter
 * produces the identical one.
 */

import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'x'.repeat(40), NODE_ENV: 'test' },
}));

/** Result sets handed back in call order, and the WHERE each call carried. */
const results: unknown[][] = [];
const wheres: unknown[] = [];

function makeChain() {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = (clause: unknown) => {
    wheres.push(clause);
    return chain;
  };
  chain.orderBy = () => chain;
  chain.limit = () => chain;
  (chain as { then: PromiseLike<unknown>['then'] }).then = (resolve, reject) =>
    Promise.resolve(results.shift() ?? []).then(resolve, reject);
  return chain;
}

vi.mock('../db/client.js', () => ({ db: { select: () => makeChain() } }));

const { resolveRegisteredEffectiveSkills } = await import('./effective.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

const bodyRow = (over: Record<string, unknown> = {}) => ({
  id: 's-1',
  name: 'forge-code',
  description: 'd',
  version: 1,
  scope: 'project',
  skillMd: '# body',
  prompt: null,
  files: [],
  installOnly: false,
  pinned: false,
  pinnedReason: null,
  ...over,
});

/** The WHERE of the last query — the body query, in every case here. */
function lastWhereSql(): { sql: string; params: unknown[] } {
  const rendered = new PgDialect().sqlToQuery(wheres.at(-1) as SQL);
  return { sql: rendered.sql, params: rendered.params };
}

beforeEach(() => {
  results.length = 0;
  wheres.length = 0;
});

describe('resolveRegisteredEffectiveSkills asks only for what it returns', () => {
  it('names the registered skills and install_only in the WHERE, so an unregistered body is never read', async () => {
    results.push([{ skillId: 'reg-1' }], [{ name: 'forge-code' }], [bodyRow()]);

    const out = await resolveRegisteredEffectiveSkills(PROJECT_ID);
    expect(out.map((s) => s.name)).toEqual(['forge-code']);

    const { sql, params } = lastWhereSql();
    expect(sql).toMatch(/"name" in/);
    expect(sql).toMatch(/"install_only"/);
    expect(params).toContain('forge-code');
    expect(params).not.toContain('forge-unregistered');
  });

  /**
   * A registration row may still point at a GLOBAL skill (legacy data). The
   * resolver matches by NAME, so the project's adopted same-name copy is what
   * comes back — the narrowing must carry that name into the WHERE, not the
   * registered id.
   */
  it('carries the NAME a legacy global registration resolves to', async () => {
    results.push(
      [{ skillId: 'global-1' }],
      [{ name: 'forge-review' }],
      [bodyRow({ id: 'project-copy', name: 'forge-review' })],
    );

    const out = await resolveRegisteredEffectiveSkills(PROJECT_ID);
    expect(out.map((s) => s.skillId)).toEqual(['project-copy']);

    const { sql, params } = lastWhereSql();
    expect(params).toContain('forge-review');
    expect(params).not.toContain('global-1');
    expect(sql).toMatch(/"scope" = /);
  });

  /**
   * installOnly skills are force-synced with zero registrations, so an empty
   * registration set must still query — the narrowing must not become "no
   * names, therefore nothing".
   */
  it('still asks for install_only skills when the project has no registration at all', async () => {
    results.push([], [bodyRow({ id: 'util-1', name: 'forge-onboard', installOnly: true })]);

    const out = await resolveRegisteredEffectiveSkills(PROJECT_ID);
    expect(out.map((s) => s.skillId)).toEqual(['util-1']);

    const { sql } = lastWhereSql();
    expect(sql).toMatch(/"install_only" = /);
    expect(sql).not.toMatch(/"name" in/);
  });

  it('asks for the project scope and this project on every path', async () => {
    results.push([], [bodyRow()]);
    await resolveRegisteredEffectiveSkills(PROJECT_ID);
    const { params } = lastWhereSql();
    expect(params).toContain(PROJECT_ID);
    expect(params).toContain('project');
  });
});
