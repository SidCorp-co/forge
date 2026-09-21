/**
 * ISS-1070 — migration `0285_agent_config_shadow_keys.sql`, applied against real Postgres.
 *
 * The subject is the file on disk, read and executed, because what is under test is what the
 * container runs at boot and not a TypeScript restatement of it: a test that inspected the SQL text
 * would pass on a file Postgres refuses.
 *
 * The harness database already has 0285 applied, so each case rebuilds a pre-migration row inside a
 * transaction, runs the file in a SAVEPOINT, asserts and rolls back. One case per branch that can
 * refuse, plus the two that must succeed, because an abort that cannot fire is a guard that covers
 * nothing. The savepoint is the mechanism of the abort cases rather than a detail: a RAISE poisons
 * the transaction it is in, and rolling back to the savepoint — which is what drizzle's per-file
 * transaction does at boot — leaves this one able to go and look at whether anything was deleted.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
} from '../helpers/index.js';

const MIGRATION_PATH = resolvePath(
  dirname(fileURLToPath(import.meta.url)),
  '../../drizzle/migrations/0285_agent_config_shadow_keys.sql',
);

const MIGRATION_STATEMENTS = readFileSync(MIGRATION_PATH, 'utf8')
  .split('--> statement-breakpoint')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

let harness: TestDatabase;
let client: Sql;

class Rollback extends Error {}

interface Ctx {
  projectId: string;
  error: string | null;
}

/** Seed one project's pre-migration state, run the file, assert, roll back. */
async function applyMigration(
  seed: (tx: Sql, ctx: { projectId: string }) => Promise<void>,
  assertions: (tx: Sql, ctx: Ctx) => Promise<void>,
): Promise<void> {
  const user = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, user.id);

  try {
    await client.begin(async (tx) => {
      await seed(tx as unknown as Sql, { projectId: project.id });

      let error: string | null = null;
      try {
        await tx.savepoint(async (sp) => {
          for (const statement of MIGRATION_STATEMENTS) {
            await sp.unsafe(statement);
          }
        });
      } catch (err) {
        error = (err as Error).message;
      }

      await assertions(tx as unknown as Sql, { projectId: project.id, error });
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
}

beforeAll(async () => {
  harness = await setupTestDatabase();
  client = harness.client;
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

describe('ISS-1070 — 0285 deletes the shadow keys and reconciles nothing', () => {
  it('deletes every retired key and leaves the disagreeing column exactly as it was', async () => {
    await applyMigration(
      async (tx, { projectId }) => {
        await tx`
          UPDATE projects
             SET repo_path = '/home/kieutrung/tools/forge',
                 base_branch = 'release/stg',
                 default_device_id = NULL,
                 agent_config = ${JSON.stringify({
                   repoPath: '/home/kieutrung/tools/forge/jarvis-agents',
                   baseBranch: 'main',
                   productionBranch: 'main',
                   activeDeviceId: '85644100-e4f5-455a-9754-6af76c19e50a',
                   runnerFallback: { type: 'claude-code' },
                   pipelineConfig: { enabled: true },
                   personaStyle: 'keep me',
                 })}::jsonb
           WHERE id = ${projectId}`;
      },
      async (tx, { projectId, error }) => {
        expect(error).toBeNull();

        const [row] = await tx`
          SELECT repo_path, base_branch, default_device_id, agent_config
            FROM projects WHERE id = ${projectId}`;

        expect(row?.agent_config).toEqual({
          pipelineConfig: { enabled: true },
          personaStyle: 'keep me',
        });
        expect(row?.repo_path).toBe('/home/kieutrung/tools/forge');
        expect(row?.base_branch).toBe('release/stg');
        expect(row?.default_device_id).toBeNull();
      },
    );
  });

  it('deletes a shadow key that agrees with its column', async () => {
    await applyMigration(
      async (tx, { projectId }) => {
        await tx`
          UPDATE projects
             SET base_branch = 'main',
                 agent_config = ${JSON.stringify({ baseBranch: 'main', plugins: [] })}::jsonb
           WHERE id = ${projectId}`;
      },
      async (tx, { projectId, error }) => {
        expect(error).toBeNull();
        const [row] =
          await tx`SELECT base_branch, agent_config FROM projects WHERE id = ${projectId}`;
        expect(row?.agent_config).toEqual({ plugins: [] });
        expect(row?.base_branch).toBe('main');
      },
    );
  });

  it('leaves a document of declared keys byte-identical', async () => {
    const declared = {
      pipelineConfig: { enabled: true },
      plugins: [],
      personaStyle: 'terse',
      systemPrompt: 'answer in Vietnamese',
      rocketChatAnswerMode: 'agent',
      categories: ['bug'],
    };
    await applyMigration(
      async (tx, { projectId }) => {
        await tx`UPDATE projects SET agent_config = ${JSON.stringify(declared)}::jsonb WHERE id = ${projectId}`;
      },
      async (tx, { projectId, error }) => {
        expect(error).toBeNull();
        const [row] = await tx`SELECT agent_config FROM projects WHERE id = ${projectId}`;
        expect(row?.agent_config).toEqual(declared);
      },
    );
  });

  it('leaves a NULL agent_config alone', async () => {
    await applyMigration(
      async (tx, { projectId }) => {
        await tx`UPDATE projects SET agent_config = NULL WHERE id = ${projectId}`;
      },
      async (tx, { projectId, error }) => {
        expect(error).toBeNull();
        const [row] = await tx`SELECT agent_config FROM projects WHERE id = ${projectId}`;
        expect(row?.agent_config).toBeNull();
      },
    );
  });

  it('aborts naming the project and the key when a row holds a key nothing declares, and deletes nothing', async () => {
    await applyMigration(
      async (tx, { projectId }) => {
        await tx`
          UPDATE projects
             SET slug = 'iss1070-stray',
                 agent_config = ${JSON.stringify({
                   uxContractProfile: { rules: [] },
                   repoPath: '/tmp/x',
                 })}::jsonb
           WHERE id = ${projectId}`;
      },
      async (tx, { projectId, error }) => {
        expect(error).toContain('ISS-1070');
        expect(error).toContain('iss1070-stray');
        expect(error).toContain("agent_config key 'uxContractProfile'");
        expect(error).toContain('Nothing was deleted');
        expect(error).toContain('agent-config-schema.ts');

        const [row] = await tx`SELECT agent_config FROM projects WHERE id = ${projectId}`;
        expect(row?.agent_config).toEqual({
          uxContractProfile: { rules: [] },
          repoPath: '/tmp/x',
        });
      },
    );
  });

  it('aborts naming the project when agent_config is not an object at all', async () => {
    await applyMigration(
      async (tx, { projectId }) => {
        await tx`
          UPDATE projects
             SET slug = 'iss1070-scalar', agent_config = '"a string"'::jsonb
           WHERE id = ${projectId}`;
      },
      async (_tx, { error }) => {
        expect(error).toContain('ISS-1070');
        expect(error).toContain('iss1070-scalar');
        expect(error).toContain('jsonb string rather than an object');
      },
    );
  });
});
