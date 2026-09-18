/**
 * ISS-1068 — the retirement migration, applied against real Postgres.
 *
 * The subject is `drizzle/migrations/0280_retire_ux_contract.sql` itself, read off disk and
 * executed statement by statement, because what is under test is what the container runs at boot
 * and not a TypeScript restatement of it. A test that inspected the SQL text would pass on a file
 * Postgres refuses.
 *
 * The harness database already has 0260 applied, so each case rebuilds the pre-migration world
 * inside a transaction — the two dropped tables recreated from 0141/0187, the backup tables
 * removed — runs the file, asserts, and rolls back. One case per branch that can refuse, plus the
 * happy path, because an abort that cannot fire is a guard that covers nothing.
 */

import { randomUUID } from 'node:crypto';
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
  '../../drizzle/migrations/0280_retire_ux_contract.sql',
);

const MIGRATION_STATEMENTS = readFileSync(MIGRATION_PATH, 'utf8')
  .split('--> statement-breakpoint')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

// The pre-0260 world, from 0141_ux_contract_tables.sql and 0187_ux_rule_supersedes.sql.
const RECREATE_DROPPED_TABLES = `
  CREATE TABLE "ux_contract_rules" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
    "group" text NOT NULL,
    "text" text NOT NULL,
    "severity" text DEFAULT 'must' NOT NULL,
    "source" text DEFAULT 'manual' NOT NULL,
    "status" text DEFAULT 'active' NOT NULL,
    "evidence_issue_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "order_index" integer DEFAULT 0 NOT NULL,
    "supersedes_rule_id" uuid REFERENCES "ux_contract_rules"("id") ON DELETE set null,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
  );
  CREATE TABLE "ux_findings" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
    "issue_id" uuid NOT NULL,
    "run_id" uuid,
    "stage" text NOT NULL,
    "rule_id" uuid REFERENCES "ux_contract_rules"("id") ON DELETE set null,
    "kind" text NOT NULL,
    "detail" text NOT NULL,
    "severity" text DEFAULT 'must' NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
  );
  DROP TABLE IF EXISTS "ux_contract_retirement_backup";
  DROP TABLE IF EXISTS "ux_contract_retirement_backup_schedules";
`;

const RULE_ONE = 'Every mutation gives feedback via a toast. No silent success.';
const RULE_TWO = 'Keyboard focus stays visible on every interactive element.';

/** The shape `compileUxContract` used to emit: the preamble, then one bullet per rule. */
function compiledProse(rules: string[]): string {
  return ['# UX Completeness Contract — test', '', ...rules.map((r) => `- ${r}`)].join('\n');
}

let harness: TestDatabase;
let client: Sql;

class Rollback extends Error {}

/**
 * Rebuild the pre-migration world, run the caller's setup, apply the migration file, hand the
 * transaction back for assertions, then roll the whole thing back.
 *
 * `result.error` is the abort message when the migration refused, and null when it ran through.
 * Asserting on it rather than on a thrown exception is what lets one case check BOTH that the
 * refusal fired AND that the tables it would have dropped are still standing.
 */
async function applyMigration(
  seed: (tx: Sql, ctx: { projectId: string }) => Promise<void>,
  assertions: (tx: Sql, ctx: { projectId: string; error: string | null }) => Promise<void>,
): Promise<void> {
  const user = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, user.id);

  try {
    await client.begin(async (tx) => {
      await tx.unsafe(RECREATE_DROPPED_TABLES);
      await seed(tx as unknown as Sql, { projectId: project.id });

      // The migration runs inside a SAVEPOINT, not bare, and that is the whole mechanism of the
      // abort cases rather than a detail: a RAISE poisons the transaction it is in, so a bare run
      // would leave nothing able to answer "and was anything dropped?". Rolling back to the
      // savepoint is exactly what drizzle's per-file transaction does at boot, and it leaves this
      // transaction usable to go and look.
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

describe('ISS-1068 — the retirement migration preserves prose or refuses by name', () => {
  it('carries both rules through and drops both tables when the entry represents them', async () => {
    const body = compiledProse([RULE_ONE, RULE_TWO]);

    await applyMigration(
      async (tx, { projectId }) => {
        await tx`
          INSERT INTO knowledge_entries (project_id, kind, slug, title, body, injection, confidence, authored_by)
          VALUES (${projectId}, 'guide', 'ux-contract', 'ux-contract', ${body}, 'always', 'verified', 'human')`;
        await tx`
          INSERT INTO ux_contract_rules (project_id, "group", text, status, order_index)
          VALUES (${projectId}, 'flows', ${RULE_ONE}, 'active', 0),
                 (${projectId}, 'a11y', ${RULE_TWO}, 'active', 1)`;
      },
      async (tx, { projectId, error }) => {
        expect(error).toBeNull();

        const [entry] = await tx`
          SELECT body, kind, injection FROM knowledge_entries
           WHERE project_id = ${projectId} AND slug = 'ux-contract'`;
        // Criterion 1: byte-identical, not summarised, regenerated or defaulted.
        expect(entry?.body).toBe(body);
        // Criteria 7 and 8.
        expect(entry?.kind).toBe('rule');
        expect(entry?.injection).toBe('on_demand');
        // Criterion 2: each rule's own text still readable in the prose that outlived it.
        expect(entry?.body).toContain(RULE_ONE);
        expect(entry?.body).toContain(RULE_TWO);

        // Criterion 9: what the entry used to be is restorable.
        const [backup] = await tx`
          SELECT kind, injection FROM ux_contract_retirement_backup
           WHERE project_id = ${projectId} AND slug = 'ux-contract'`;
        expect(backup).toMatchObject({ kind: 'guide', injection: 'always' });

        // Criteria 5 and 6.
        const tables = await tx`
          SELECT tablename FROM pg_tables
           WHERE schemaname = current_schema()
             AND tablename IN ('ux_contract_rules', 'ux_findings')`;
        expect(tables).toEqual([]);
      },
    );
  });

  it('refuses by name, and drops nothing, when a rule-holding project has no entry', async () => {
    await applyMigration(
      async (tx, { projectId }) => {
        await tx`
          INSERT INTO ux_contract_rules (project_id, "group", text, status, order_index)
          VALUES (${projectId}, 'flows', ${RULE_ONE}, 'active', 0)`;
      },
      async (tx, { error }) => {
        // Criterion 3: the project is named, and the refusal says what to do.
        expect(error).toContain('ISS-1068');
        expect(error).toContain('no live knowledge entry');
        expect(error).toContain('knowledge/ux-contract');

        const tables = await tx`
          SELECT tablename FROM pg_tables
           WHERE schemaname = current_schema()
             AND tablename IN ('ux_contract_rules', 'ux_findings')
           ORDER BY tablename`;
        expect(tables.map((t) => t.tablename)).toEqual(['ux_contract_rules', 'ux_findings']);
      },
    );
  });

  it('refuses by name, quoting the rule, when the entry does not represent an active rule', async () => {
    // The entry carries RULE_ONE and not RULE_TWO — a stale body, which an existence check passes.
    const staleBody = compiledProse([RULE_ONE]);

    await applyMigration(
      async (tx, { projectId }) => {
        await tx`
          INSERT INTO knowledge_entries (project_id, kind, slug, title, body, injection, confidence, authored_by)
          VALUES (${projectId}, 'guide', 'ux-contract', 'ux-contract', ${staleBody}, 'always', 'verified', 'human')`;
        await tx`
          INSERT INTO ux_contract_rules (project_id, "group", text, status, order_index)
          VALUES (${projectId}, 'flows', ${RULE_ONE}, 'active', 0),
                 (${projectId}, 'a11y', ${RULE_TWO}, 'active', 1)`;
      },
      async (tx, { projectId, error }) => {
        // Criterion 4: the unrepresented rule is quoted, so the operator can act on it.
        expect(error).toContain('ISS-1068');
        expect(error).toContain('does not appear');
        expect(error).toContain(RULE_TWO);
        expect(error).not.toContain(RULE_ONE);

        const tables = await tx`
          SELECT tablename FROM pg_tables
           WHERE schemaname = current_schema()
             AND tablename IN ('ux_contract_rules', 'ux_findings')`;
        expect(tables).toHaveLength(2);

        // Nothing was rewritten either: the entry is still what it was.
        const [entry] = await tx`
          SELECT kind, injection FROM knowledge_entries
           WHERE project_id = ${projectId} AND slug = 'ux-contract'`;
        expect(entry).toMatchObject({ kind: 'guide', injection: 'always' });
      },
    );
  });

  it('lets a RETIRED rule the prose no longer carries through, because only active rules bind', async () => {
    const body = compiledProse([RULE_ONE]);

    await applyMigration(
      async (tx, { projectId }) => {
        await tx`
          INSERT INTO knowledge_entries (project_id, kind, slug, title, body, injection, confidence, authored_by)
          VALUES (${projectId}, 'guide', 'ux-contract', 'ux-contract', ${body}, 'on_demand', 'verified', 'human')`;
        await tx`
          INSERT INTO ux_contract_rules (project_id, "group", text, status, order_index)
          VALUES (${projectId}, 'flows', ${RULE_ONE}, 'active', 0),
                 (${projectId}, 'a11y', ${RULE_TWO}, 'retired', 1)`;
      },
      async (_tx, { error }) => {
        expect(error).toBeNull();
      },
    );
  });

  it('refuses by name when a ux-contract-improve schedule is ENABLED', async () => {
    await applyMigration(
      async (tx, { projectId }) => {
        await tx`
          INSERT INTO schedules (id, project_id, name, cron, enabled, template_key, kind)
          VALUES (${randomUUID()}, ${projectId}, 'improver', '0 23 * * 3', true, 'ux-contract-improve', 'prompt')`;
      },
      async (tx, { error }) => {
        // Criterion 11.
        expect(error).toContain('ISS-1068');
        expect(error).toContain('is ENABLED');
        expect(error).toContain('ux-contract-improve');

        const rows = await tx`SELECT id FROM schedules WHERE template_key = 'ux-contract-improve'`;
        expect(rows).toHaveLength(1);
      },
    );
  });

  // cm:guard the assertion is the RESTORE, not the presence of a backup row. A backup of a chosen
  // handful of columns reads exactly like a real one and cannot be inserted back — `schedules.name`
  // is NOT NULL with no default — so "a copy exists" is the check that would have passed on the
  // shape this case exists to refuse. Every field below is a non-default value for that reason.
  it('removes a DISABLED ux-contract-improve schedule and its backup restores the whole row', async () => {
    const scheduleId = randomUUID();

    await applyMigration(
      async (tx, { projectId }) => {
        await tx`
          INSERT INTO schedules (id, project_id, name, cron, enabled, template_key, kind, prompt, mode, params, metadata)
          VALUES (${scheduleId}, ${projectId}, 'the weekly improver', '0 23 * * 3', false,
                  'ux-contract-improve', 'prompt', 'RAW PROMPT', 'propose',
                  ${'{"keys":["a"]}'}::jsonb, ${'{"note":"set by a person"}'}::jsonb)`;
      },
      async (tx, { error }) => {
        expect(error).toBeNull();

        // Criterion 10.
        const live = await tx`SELECT id FROM schedules WHERE id = ${scheduleId}`;
        expect(live).toEqual([]);

        // Restore it from the backup alone — the statement the migration's own comment documents.
        await tx`
          INSERT INTO schedules
          SELECT (jsonb_populate_record(NULL::schedules, row)).*
            FROM ux_contract_retirement_backup_schedules
           WHERE id = ${scheduleId}`;

        const [restored] = await tx`
          SELECT name, cron, enabled, template_key, kind, prompt, mode, params, metadata
            FROM schedules WHERE id = ${scheduleId}`;
        expect(restored).toMatchObject({
          name: 'the weekly improver',
          cron: '0 23 * * 3',
          enabled: false,
          template_key: 'ux-contract-improve',
          kind: 'prompt',
          prompt: 'RAW PROMPT',
          mode: 'propose',
          params: { keys: ['a'] },
          metadata: { note: 'set by a person' },
        });
      },
    );
  });

  it('strips uxContractProfile from agentConfig and leaves its siblings alone', async () => {
    await applyMigration(
      async (tx, { projectId }) => {
        const config = JSON.stringify({
          uxContractProfile: { projectLabel: 'x' },
          plugins: ['keep-me'],
        });
        await tx`UPDATE projects SET agent_config = ${config}::jsonb WHERE id = ${projectId}`;
      },
      async (tx, { projectId, error }) => {
        expect(error).toBeNull();

        const [row] = await tx`SELECT agent_config FROM projects WHERE id = ${projectId}`;
        const config = row?.agent_config as Record<string, unknown>;
        // Criterion 12, and the sibling key is the wholesale-config-clobber check.
        expect(config).not.toHaveProperty('uxContractProfile');
        expect(config.plugins).toEqual(['keep-me']);
      },
    );
  });
});
