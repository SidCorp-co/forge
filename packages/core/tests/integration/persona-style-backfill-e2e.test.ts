/**
 * ISS-1007 — migration 0246, run against a real Postgres over the binding shapes
 * the fleet actually holds.
 *
 * The statement's whole job is to keep a reply language that stopped being
 * hardcoded in the Rocket.Chat persona, and getting the WHO wrong is the way it
 * loses one: `buildRoutes` reaches a project only through an active connection
 * holding an active binding whose `config.rids` names a room, and each of those
 * three is a way to be wrong here. So every shape is seeded and asserted, the
 * ones that must change and the ones that must not.
 *
 * The migration has already run by the time this file starts, so it is
 * re-applied against rows seeded afterwards — which is also the idempotence case
 * the statement's own skip clause promises.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const migrationPath = fileURLToPath(
  new URL('../../drizzle/migrations/0246_persona_style_backfill.sql', import.meta.url),
);
const MIGRATION = readFileSync(migrationPath, 'utf8');

const SENTENCE =
  'Reply in Vietnamese (switch language only if the user clearly writes another one).';

type Harness = TestDatabase;

/** A connection and a binding, in whichever of the three states this case is about. */
async function bindRocketChat(
  harness: Harness,
  args: {
    projectId: string;
    ownerId: string;
    rids: string[];
    bindingActive: boolean;
    connectionActive: boolean;
    label?: string;
    /** The CONNECTION's provider, which nothing in the schema ties to the binding's. */
    connectionProvider?: string;
  },
): Promise<void> {
  const connectionId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO integration_connections (id, owner_type, owner_id, provider, config, active)
    VALUES (${connectionId}, 'user', ${args.ownerId}, ${args.connectionProvider ?? 'rocketchat'}, '{}'::jsonb, ${args.connectionActive})
  `);
  await harness.db.execute(sql`
    INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, label, config, active)
    VALUES (
      ${randomUUID()}, ${connectionId}, ${args.projectId}, 'rocketchat', 'service', ${args.label ?? ''},
      ${JSON.stringify({ rids: args.rids })}::jsonb, ${args.bindingActive}
    )
  `);
}

async function styleOf(harness: Harness, projectId: string): Promise<string | undefined> {
  const rows = (await harness.db.execute(
    sql`SELECT agent_config FROM projects WHERE id = ${projectId}`,
  )) as unknown as Array<{ agent_config: Record<string, unknown> | null }>;
  return rows[0]?.agent_config?.personaStyle as string | undefined;
}

describe('migration 0246 moves the reply language onto the projects that were getting it', () => {
  let harness: Harness;
  const id: Record<string, string> = {};

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.NODE_ENV ??= 'test';
    await truncateAll(harness.db);
    const user = await createTestUser(harness.db);

    const make = async (key: string, agentConfig: Record<string, unknown>) => {
      const p = await createTestProject(harness.db, user.id, { agentConfig });
      id[key] = p.id;
      return p.id;
    };

    await bindRocketChat(harness, {
      projectId: await make('bare', {}),
      ownerId: user.id,
      rids: ['GENERAL'],
      bindingActive: true,
      connectionActive: true,
    });
    await bindRocketChat(harness, {
      projectId: await make('styled', { personaStyle: 'Use a formal tone.' }),
      ownerId: user.id,
      rids: ['GENERAL'],
      bindingActive: true,
      connectionActive: true,
    });
    await bindRocketChat(harness, {
      projectId: await make('already', { personaStyle: `${SENTENCE}\nUse a formal tone.` }),
      ownerId: user.id,
      rids: ['GENERAL'],
      bindingActive: true,
      connectionActive: true,
    });
    await bindRocketChat(harness, {
      projectId: await make('noRooms', {}),
      ownerId: user.id,
      rids: [],
      bindingActive: true,
      connectionActive: true,
    });
    await bindRocketChat(harness, {
      projectId: await make('deadConnection', {}),
      ownerId: user.id,
      rids: ['GENERAL'],
      bindingActive: true,
      connectionActive: false,
    });
    await bindRocketChat(harness, {
      projectId: await make('inactiveBinding', {}),
      ownerId: user.id,
      rids: ['GENERAL'],
      bindingActive: false,
      connectionActive: true,
    });

    const mixed = await make('mixed', {});
    await bindRocketChat(harness, {
      projectId: mixed,
      ownerId: user.id,
      rids: [],
      bindingActive: true,
      connectionActive: true,
      label: 'roomless',
    });
    await bindRocketChat(harness, {
      projectId: mixed,
      ownerId: user.id,
      rids: ['GENERAL'],
      bindingActive: true,
      connectionActive: true,
      label: 'routing',
    });

    await make('noBinding', {});

    await bindRocketChat(harness, {
      projectId: await make('foreignConnection', {}),
      ownerId: user.id,
      rids: ['GENERAL'],
      bindingActive: true,
      connectionActive: true,
      connectionProvider: 'coolify',
    });

    await bindRocketChat(harness, {
      projectId: await make('atTheCap', { personaStyle: 'x'.repeat(4000) }),
      ownerId: user.id,
      rids: ['GENERAL'],
      bindingActive: true,
      connectionActive: true,
    });

    await harness.db.execute(sql.raw(MIGRATION));
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup?.();
  });

  it('gives a routed project with no style the sentence on its own', async () => {
    expect(await styleOf(harness, id.bare as string)).toBe(SENTENCE);
  });

  it('keeps a style somebody wrote and puts the sentence ahead of it', async () => {
    expect(await styleOf(harness, id.styled as string)).toBe(`${SENTENCE}\nUse a formal tone.`);
  });

  it('leaves a style that already carries the sentence exactly as it was', async () => {
    expect(await styleOf(harness, id.already as string)).toBe(`${SENTENCE}\nUse a formal tone.`);
  });

  it('leaves a binding that routes no room alone', async () => {
    expect(await styleOf(harness, id.noRooms as string)).toBeUndefined();
  });

  it('leaves a binding whose connection is inactive alone', async () => {
    expect(await styleOf(harness, id.deadConnection as string)).toBeUndefined();
  });

  it('leaves an inactive binding alone', async () => {
    expect(await styleOf(harness, id.inactiveBinding as string)).toBeUndefined();
  });

  it('leaves a project with no Rocket.Chat binding alone', async () => {
    expect(await styleOf(harness, id.noBinding as string)).toBeUndefined();
  });

  it('leaves a rocketchat-labelled binding whose connection is another provider alone', async () => {
    expect(await styleOf(harness, id.foreignConnection as string)).toBeUndefined();
  });

  it('backfills a project reached by one routed binding and one that routes nothing', async () => {
    expect(await styleOf(harness, id.mixed as string)).toBe(SENTENCE);
  });

  it('writes nothing on a second run', async () => {
    const before = await Promise.all(
      Object.values(id).map(async (projectId) => [projectId, await styleOf(harness, projectId)]),
    );
    await harness.db.execute(sql.raw(MIGRATION));
    const after = await Promise.all(
      Object.values(id).map(async (projectId) => [projectId, await styleOf(harness, projectId)]),
    );
    expect(after).toEqual(before);
  });

  it('leaves a lengthened style the project update endpoint still accepts', async () => {
    const style = await styleOf(harness, id.atTheCap as string);
    expect(style?.length).toBeGreaterThan(4000);
    const { updateProjectSchema } = await import('../../src/projects/routes.js');
    expect(updateProjectSchema.safeParse({ personaStyle: style }).success).toBe(true);
  });
});
