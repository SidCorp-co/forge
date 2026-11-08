// @direct-test-of packages/core/src/
// @direct-test-when \.(insert|update|delete)\(|INSERT INTO|UPDATE \w|DELETE FROM
// The writers of the builder rule's inputs and of its model (ISS-1070 r5, 0627). Each input table's
// trigger marks the issue whoever writes it, so a writer needs no call of its own; what this holds is
// the list: a module that starts writing an input is named here before it lands, so a reviewer reads
// that its write goes through the trigger (no `session_replication_role`, no trigger switched off),
// and the model's own tables are written by its owner alone. The trigger on each table is checked
// against the database in `tests/integration/builder-facts-model-e2e.test.ts`; the statuses the
// session trigger reads as ended are held to the session machine's here (ISS-1070 r6).

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TERMINAL_AGENT_SESSION_STATUSES } from '@forge/contracts/session-machine';
import { describe, expect, it } from 'vitest';
import { BUILDER_INPUT_TABLES } from './builder-facts.js';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const MIGRATIONS = fileURLToPath(new URL('../../drizzle/migrations', import.meta.url));

/** Every module writing each input table today, by path under `src/`. */
const WRITERS: Record<(typeof BUILDER_INPUT_TABLES)[number]['table'], readonly string[]> = {
  criterion_verdicts: [
    'issues/criteria/backfill.ts',
    'issues/criteria/close-verdicts.ts',
    'issues/criteria/verdict-record.ts',
  ],
  issue_check_runs: ['issues/check-runs.ts'],
  issue_leases: ['issues/issue-lease.ts'],
  pipeline_runs: [
    'pipeline/deploy-confirmations.ts',
    'pipeline/run-records.ts',
    'pipeline/runs.ts',
  ],
  agent_sessions: [
    'agent-sessions/auto-title.ts',
    'agent-sessions/chat-turn.ts',
    'agent-sessions/recovery-stats.ts',
    'agent-sessions/service.ts',
    'agent-sessions/session-send.ts',
    'agent-sessions/session-transcript.ts',
    'agent-sessions/session-transition.ts',
    'agent-sessions/writes.ts',
  ],
  issues: [
    'issues/close-in-scope.ts',
    'issues/create-service.ts',
    'issues/criteria/criterion-reword.ts',
    'issues/criteria/store.ts',
    'issues/criteria/tie.ts',
    'issues/draft-release-notes.ts',
    'issues/field-writes.ts',
    'issues/merge-record.ts',
    'issues/park-repoint.ts',
    'issues/release-claim.ts',
    'issues/requirement-link.ts',
    'issues/service.ts',
    'issues/strand-write.ts',
    'issues/update-service.ts',
  ],
  kernel_transitions: ['lifecycle/transition.ts'],
  issue_criteria: [
    'issues/close-in-scope.ts',
    'issues/criteria/backfill.ts',
    'issues/criteria/criterion-reword.ts',
    'issues/criteria/retie.ts',
    'issues/criteria/store.ts',
    'issues/criteria/tie.ts',
  ],
};

/** The model's own tables: only its owner writes them. */
const MODEL_TABLES = ['verdict_builder_facts', 'issue_read_model_stale'] as const;
const OWNER = 'issues/builder-facts.ts';

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [path] : [];
  });
}

const camel = (table: string) => table.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** Whether `text` writes `table`, by drizzle's builder or by raw SQL. */
function writes(text: string, table: string): boolean {
  const builder = new RegExp(`\\.(insert|update|delete)\\(\\s*${camel(table)}\\s*\\)`);
  const raw = new RegExp(`(INSERT INTO|UPDATE|DELETE FROM)\\s+"?${table}"?\\b`);
  return builder.test(text) || raw.test(text);
}

/** Each module writing `table`, under `src/`. */
function writersOf(files: readonly string[], table: string): string[] {
  return files
    .filter((f) => writes(readFileSync(f, 'utf8'), table))
    .map((f) => relative(SRC, f))
    .sort();
}

describe('the writers of the builder rule inputs', () => {
  const files = sources(SRC);

  it('names every module that writes an input table, each marked by its trigger', () => {
    const unnamed = BUILDER_INPUT_TABLES.flatMap(({ table }) =>
      writersOf(files, table)
        .filter((f) => !WRITERS[table].includes(f))
        .map((f) => `${f} writes ${table}, an input of the builder rule, and is not named here`),
    );
    expect(unnamed).toEqual([]);
  });

  it('lets no module switch an input trigger off', () => {
    const past = files
      .filter((f) => /session_replication_role|DISABLE TRIGGER/i.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f));
    expect(past).toEqual([]);
  });

  it('lets only the owner write the model', () => {
    const others = MODEL_TABLES.flatMap((t) =>
      writersOf(files, t)
        .filter((f) => f !== OWNER)
        .map((f) => `${f} writes ${t}`),
    );
    expect(others).toEqual([]);
  });
});

/**
 * The statuses the session trigger's last definition names as ended (0627): a session that ends
 * marks its issue on a later write of its `updated_at` only while it reads ended there, so the list
 * written into the migration has to be the session machine's own.
 */
function triggerEndedStatuses(): string[] {
  const defined = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'))
    .flatMap((sql) => [
      ...sql.matchAll(/CREATE TRIGGER forge_builder_inputs_sessions_upd[\s\S]*?EXECUTE FUNCTION/g),
    ])
    .map((m) => m[0]);
  const last = defined.at(-1);
  if (!last) throw new Error('no migration defines forge_builder_inputs_sessions_upd');
  const list = /NEW\.status IN \(([^)]*)\)/.exec(last)?.[1];
  if (!list) throw new Error('forge_builder_inputs_sessions_upd names no ended statuses');
  return [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string).sort();
}

describe('the session trigger of the builder rule', () => {
  it("names as ended exactly the session machine's terminal statuses", () => {
    expect(triggerEndedStatuses()).toEqual([...TERMINAL_AGENT_SESSION_STATUSES].sort());
  });
});
