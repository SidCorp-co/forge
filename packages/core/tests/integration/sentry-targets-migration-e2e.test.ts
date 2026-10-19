/**
 * ISS-1380 — the shipped migration, run against the rows the old code left behind.
 *
 * The statement is read out of `0340_...sql` rather than restated, because what has to hold is what
 * the deploy will execute. Four properties:
 *   - a connection's targets reach the one binding that was reading them, and leave the connection;
 *   - a connection whose targets cannot go to exactly one binding ABORTS the deploy naming it, and
 *     changes no row — beta's shared connection is that case;
 *   - what a project could resolve before it still resolves (the legacy single-slug target);
 *   - nothing that is not a Sentry connection is touched.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const MIGRATION = fileURLToPath(
  new URL(
    '../../drizzle/migrations/0340_a_sentry_target_belongs_to_the_project_that_names_it.sql',
    import.meta.url,
  ),
);

let harness: TestDatabase;
let ownerId: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db)).id;
});

/** The whole shipped file: it is one `DO` block, so what runs here is what the deploy runs. */
const migrate = () => harness.db.execute(sql.raw(readFileSync(MIGRATION, 'utf8')));

async function failureTextOf(call: Promise<unknown>): Promise<string> {
  try {
    await call;
    return '';
  } catch (err) {
    const e = err as { message?: string; cause?: { message?: string } };
    return `${e.message ?? ''} ${e.cause?.message ?? ''}`;
  }
}

const target = (label: string, projectSlug = label) => ({
  label,
  organizationSlug: 'canawan',
  projectSlug,
});

async function aConnection(
  config: Record<string, unknown>,
  opts: { provider?: string; name?: string } = {},
): Promise<string> {
  const rows = (await harness.db.execute(sql`
    INSERT INTO integration_connections (owner_type, owner_id, provider, display_name, config, active)
    VALUES ('user', ${ownerId}::uuid, ${opts.provider ?? 'sentry'}, ${opts.name ?? 'logs'},
            ${JSON.stringify(config)}::jsonb, true)
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return String(rows[0]?.id);
}

async function aBinding(
  connectionId: string,
  config: Record<string, unknown> = {},
  opts: { active?: boolean; provider?: string } = {},
): Promise<{ id: string; projectId: string }> {
  const project = await createTestProject(harness.db, ownerId);
  const rows = (await harness.db.execute(sql`
    INSERT INTO integration_bindings
      (connection_id, project_id, provider, role, stages, config, active, agent_access)
    VALUES (${connectionId}::uuid, ${project.id}::uuid, ${opts.provider ?? 'sentry'}, 'service',
            ARRAY[]::text[], ${JSON.stringify(config)}::jsonb, ${opts.active ?? true}, 'all')
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return { id: String(rows[0]?.id), projectId: project.id };
}

async function configOf(table: 'integration_connections' | 'integration_bindings', id: string) {
  const rows = (await harness.db.execute(
    sql`SELECT config FROM ${sql.raw(table)} WHERE id = ${id}::uuid`,
  )) as unknown as Array<{ config: Record<string, unknown> }>;
  return rows[0]?.config;
}

describe('a connection with one binding', () => {
  it('moves its targets onto that binding and leaves the host and the binding config alone', async () => {
    const conn = await aConnection({
      host: 'logs.canawan.com',
      targets: [target('core'), target('web')],
    });
    const binding = await aBinding(conn, { releaseRunnerLabel: 'box-a' });

    await migrate();

    expect(await configOf('integration_bindings', binding.id)).toEqual({
      releaseRunnerLabel: 'box-a',
      targets: [target('core'), target('web')],
    });
    expect(
      await configOf('integration_connections', conn),
      'a connection still carrying the list is read by nobody now, and by every project if the code is rolled back',
    ).toEqual({ host: 'logs.canawan.com' });
  });
});

describe('a connection whose targets cannot go to exactly one binding', () => {
  it('aborts naming the connection, its host and every binding, and changes no row', async () => {
    const conn = await aConnection(
      { host: 'logs.canawan.com', targets: [target('a'), target('b')] },
      { name: 'shared' },
    );
    const first = await aBinding(conn);
    const second = await aBinding(conn);

    const failure = await failureTextOf(migrate());

    expect(failure).toContain('ISS-1380');
    expect(failure).toContain(conn);
    expect(failure).toContain('shared');
    expect(failure).toContain('logs.canawan.com');
    expect(failure).toContain(first.id);
    expect(failure).toContain(second.id);
    expect(await configOf('integration_connections', conn)).toEqual({
      host: 'logs.canawan.com',
      targets: [target('a'), target('b')],
    });
    expect(await configOf('integration_bindings', first.id)).toEqual({});
    expect(await configOf('integration_bindings', second.id)).toEqual({});
  });

  it('aborts for a connection no binding uses, rather than dropping its targets', async () => {
    const conn = await aConnection({ host: 'logs.canawan.com', targets: [target('orphan')] });

    const failure = await failureTextOf(migrate());

    expect(failure).toContain(conn);
    expect(failure).toContain('no binding at all');
    expect((await configOf('integration_connections', conn))?.targets).toEqual([target('orphan')]);
  });

  it('aborts naming a connection whose `targets` is not a list', async () => {
    const conn = await aConnection({ host: 'logs.canawan.com', targets: 'core' });
    await aBinding(conn);

    const failure = await failureTextOf(migrate());

    expect(failure).toContain(conn);
    expect(failure).toContain('not a list');
  });

  it('is what beta holds: 11 targets over 5 bindings aborts, and passes once each binding carries its own', async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => target(`t${i}`));
    const conn = await aConnection(
      { host: 'https://logs.canawan.com', targets: eleven },
      { name: 'sid-desk' },
    );
    const bindings = [];
    for (let i = 0; i < 5; i++) bindings.push(await aBinding(conn));

    expect(await failureTextOf(migrate())).toContain(conn);

    // The operator's answer, as the abort message words it: each binding gets its own targets.
    for (const [i, b] of bindings.entries()) {
      await harness.db.execute(sql`
        UPDATE integration_bindings SET config = ${JSON.stringify({ targets: [target(`t${i}`)] })}::jsonb
         WHERE id = ${b.id}::uuid
      `);
    }
    await migrate();

    expect(await configOf('integration_connections', conn)).toEqual({
      host: 'https://logs.canawan.com',
    });
    for (const [i, b] of bindings.entries()) {
      expect(await configOf('integration_bindings', b.id)).toEqual({ targets: [target(`t${i}`)] });
    }
  });
});

describe('what a project could resolve before still resolves', () => {
  it('writes a legacy organization and project as a `default` target', async () => {
    const conn = await aConnection({
      host: 'logs.canawan.com',
      organizationSlug: 'canawan',
      projectSlug: 'web',
    });
    const binding = await aBinding(conn);

    await migrate();

    expect(await configOf('integration_bindings', binding.id)).toEqual({
      targets: [{ label: 'default', organizationSlug: 'canawan', projectSlug: 'web' }],
    });
    expect(await configOf('integration_connections', conn)).toEqual({ host: 'logs.canawan.com' });
  });

  it('keeps an organization-only legacy connection org-wide, with no project invented', async () => {
    const conn = await aConnection({ host: 'logs.canawan.com', organizationSlug: 'canawan' });
    const binding = await aBinding(conn);

    await migrate();

    expect(await configOf('integration_bindings', binding.id)).toEqual({
      targets: [{ label: 'default', organizationSlug: 'canawan' }],
    });
  });

  it('reads legacy slugs beside an empty targets list as the default target they always resolved', async () => {
    const conn = await aConnection({
      host: 'logs.canawan.com',
      targets: [],
      organizationSlug: 'canawan',
      projectSlug: 'web',
    });
    const binding = await aBinding(conn);

    await migrate();

    expect(await configOf('integration_bindings', binding.id)).toEqual({
      targets: [{ label: 'default', organizationSlug: 'canawan', projectSlug: 'web' }],
    });
    expect(await configOf('integration_connections', conn)).toEqual({ host: 'logs.canawan.com' });
  });

  it('drops legacy slugs that sit beside real targets, which were never read', async () => {
    const conn = await aConnection({
      host: 'logs.canawan.com',
      targets: [target('Mobile')],
      organizationSlug: 'canawan',
      projectSlug: 'anhome-mobile',
    });
    const binding = await aBinding(conn);

    await migrate();

    expect(await configOf('integration_bindings', binding.id)).toEqual({
      targets: [target('Mobile')],
    });
    expect(await configOf('integration_connections', conn)).toEqual({ host: 'logs.canawan.com' });
  });
});

describe('a binding that already holds its own targets', () => {
  it('keeps an explicitly empty list, which resolved no target before and must resolve none after', async () => {
    const conn = await aConnection({
      host: 'logs.canawan.com',
      targets: [target('a'), target('b')],
    });
    const binding = await aBinding(conn, { targets: [] });

    await migrate();

    expect(
      await configOf('integration_bindings', binding.id),
      'an empty binding list overrode the connection list; copying it in would grant reads the binding never declared',
    ).toEqual({ targets: [] });
    expect(await configOf('integration_connections', conn)).toEqual({ host: 'logs.canawan.com' });
  });

  it('still lets an empty list inherit the legacy default target it never overrode', async () => {
    const conn = await aConnection({
      host: 'logs.canawan.com',
      organizationSlug: 'canawan',
      projectSlug: 'web',
    });
    const binding = await aBinding(conn, { targets: [] });

    await migrate();

    expect(await configOf('integration_bindings', binding.id)).toEqual({
      targets: [{ label: 'default', organizationSlug: 'canawan', projectSlug: 'web' }],
    });
  });

  it('keeps them, and the connection copy it overrode is removed', async () => {
    const conn = await aConnection({ host: 'logs.canawan.com', targets: [target('old')] });
    const first = await aBinding(conn, { targets: [target('mine')] });
    const second = await aBinding(conn, { targets: [target('theirs')] });

    await migrate();

    expect(await configOf('integration_bindings', first.id)).toEqual({ targets: [target('mine')] });
    expect(await configOf('integration_bindings', second.id)).toEqual({
      targets: [target('theirs')],
    });
    expect(await configOf('integration_connections', conn)).toEqual({ host: 'logs.canawan.com' });
  });

  it('is not counted as inheriting: the one binding without its own takes the list', async () => {
    const conn = await aConnection({ host: 'logs.canawan.com', targets: [target('shared')] });
    const own = await aBinding(conn, { targets: [target('mine')] });
    const inheriting = await aBinding(conn);

    await migrate();

    expect(await configOf('integration_bindings', own.id)).toEqual({ targets: [target('mine')] });
    expect(await configOf('integration_bindings', inheriting.id)).toEqual({
      targets: [target('shared')],
    });
  });

  it('prefers the active inheriting binding over an inactive one', async () => {
    const conn = await aConnection({ host: 'logs.canawan.com', targets: [target('shared')] });
    const live = await aBinding(conn);
    const retired = await aBinding(conn, {}, { active: false });

    await migrate();

    expect(await configOf('integration_bindings', live.id)).toEqual({
      targets: [target('shared')],
    });
    expect(await configOf('integration_bindings', retired.id)).toEqual({});
  });
});

describe('what is not a Sentry connection with targets', () => {
  it('leaves another provider holding `targets` exactly as it was', async () => {
    const coolify = await aConnection(
      { baseUrl: 'https://c.example', targets: [{ label: 'web', resourceUuid: 'abc' }] },
      { provider: 'coolify' },
    );
    await aBinding(coolify, {}, { provider: 'coolify' });

    await migrate();

    expect(
      (await configOf('integration_connections', coolify))?.targets,
      'coolify bindings inherit their connection targets on purpose',
    ).toEqual([{ label: 'web', resourceUuid: 'abc' }]);
  });

  it('leaves a Sentry connection that holds no targets alone', async () => {
    const conn = await aConnection({ host: 'logs.canawan.com' });
    const binding = await aBinding(conn, { targets: [target('mine')] });

    await migrate();

    expect(await configOf('integration_connections', conn)).toEqual({ host: 'logs.canawan.com' });
    expect(await configOf('integration_bindings', binding.id)).toEqual({
      targets: [target('mine')],
    });
  });

  it('runs twice to the same rows', async () => {
    const conn = await aConnection({ host: 'logs.canawan.com', targets: [target('core')] });
    const binding = await aBinding(conn);

    await migrate();
    await migrate();

    expect(await configOf('integration_bindings', binding.id)).toEqual({
      targets: [target('core')],
    });
    expect(await configOf('integration_connections', conn)).toEqual({ host: 'logs.canawan.com' });
  });
});
