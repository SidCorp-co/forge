// The writers of the builder rule's inputs and of its model (ISS-1070 r5, 0627). Each input table's
// trigger marks the issue whoever writes it, so a writer needs no call of its own; what this holds is
// the list: a module that starts writing an input is named here before it lands, so a reviewer reads
// that its write goes through the trigger (no `session_replication_role`, no trigger switched off),
// and the model's own tables are written by its owner alone. The trigger on each table is checked
// against the database in `tests/integration/builder-facts-model-e2e.test.ts`.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUILDER_INPUT_TABLES } from './builder-facts.js';

const SRC = fileURLToPath(new URL('..', import.meta.url));

/** Every module writing each input table today, by path under `src/`. */
const WRITERS: Record<(typeof BUILDER_INPUT_TABLES)[number]['table'], readonly string[]> = {
  criterion_verdicts: ['issues/criteria/backfill.ts', 'issues/criteria/verdict-record.ts'],
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
