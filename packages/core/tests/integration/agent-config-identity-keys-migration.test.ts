/**
 * Migration `0325_agent_config_drops_its_identity_keys.sql`, read off disk and run against real
 * Postgres inside a savepoint that is rolled back, the way `agent-config-shadow-keys.test.ts`
 * holds 0285.
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

const MIGRATION = readFileSync(
  resolvePath(
    dirname(fileURLToPath(import.meta.url)),
    '../../drizzle/migrations/0325_agent_config_drops_its_identity_keys.sql',
  ),
  'utf8',
);

let harness: TestDatabase;
let client: Sql;

class Rollback extends Error {}

async function migrate(agentConfig: unknown): Promise<{ after: unknown; error: string | null }> {
  const user = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, user.id);
  let out: { after: unknown; error: string | null } = { after: null, error: null };
  try {
    await client.begin(async (tx) => {
      await tx`UPDATE projects SET agent_config = ${JSON.stringify(agentConfig)}::jsonb WHERE id = ${project.id}`;
      let error: string | null = null;
      try {
        await tx.savepoint(async (sp) => {
          await sp.unsafe(MIGRATION);
        });
      } catch (err) {
        error = (err as Error).message;
      }
      const [row] = await tx`SELECT agent_config FROM projects WHERE id = ${project.id}`;
      out = { after: row?.agent_config ?? null, error };
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return out;
}

beforeAll(async () => {
  harness = await setupTestDatabase();
  client = harness.client;
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

describe('0324 removes the deleted agent_config keys and nothing else', () => {
  it('removes the four top-level keys and every plugin autoUpdate, keeping the rest in order', async () => {
    const weekly = { enabled: true, pinnedIssue: 'ISS-1', judgeProviderId: 'p', judgeModel: 'm' };
    const { after, error } = await migrate({
      personaStyle: 'Reply in Vietnamese',
      systemPrompt: 'answer briefly',
      rocketChatAnswerMode: 'agent',
      categories: ['bug'],
      assistantWeekly: weekly,
      plugins: [
        { marketplace: 'SidCorp-co/forge-plugin', name: 'forge', autoUpdate: true },
        { marketplace: 'a/b', name: 'code-quality', pinnedRef: 'abc1234', autoUpdate: false },
      ],
    });
    expect(error).toBeNull();
    expect(after).toEqual({
      assistantWeekly: weekly,
      plugins: [
        { marketplace: 'SidCorp-co/forge-plugin', name: 'forge' },
        { marketplace: 'a/b', name: 'code-quality', pinnedRef: 'abc1234' },
      ],
    });
  });

  it('leaves a document holding none of them exactly as it was', async () => {
    const doc = { plugins: [{ marketplace: 'a/b', name: 'forge' }] };
    expect(await migrate(doc)).toEqual({ after: doc, error: null });
  });

  it('stops the deploy naming the project whose plugins is not a list', async () => {
    const { after, error } = await migrate({ plugins: { forge: true }, personaStyle: 'x' });
    expect(error).toContain('stores agent_config.plugins as a object, not a list');
    expect(after).toEqual({ plugins: { forge: true }, personaStyle: 'x' });
  });
});
