// The criteria facts' own tables (ISS-1070 r7, 0633) are written by their owner alone: every input's
// write marks through its trigger (`tests/integration/criteria-facts-model-e2e.test.ts` holds the
// triggers to the inputs), and no other module writes the stored facts or clears a mark.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const MODEL_TABLES = ['issue_criteria_facts', 'issue_criteria_facts_stale'] as const;
const OWNER = 'requirements/criteria-facts.ts';

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

describe('the writers of the criteria facts', () => {
  it('lets only the owner write the model', () => {
    const others = sources(SRC).flatMap((f) =>
      MODEL_TABLES.filter((t) => writes(readFileSync(f, 'utf8'), t))
        .map((t) => [relative(SRC, f), t] as const)
        .filter(([path]) => path !== OWNER)
        .map(([path, t]) => `${path} writes ${t}`),
    );
    expect(others).toEqual([]);
  });

  it('finds the owner writing both tables, so the search reads what it claims', () => {
    const owner = readFileSync(join(SRC, OWNER), 'utf8');
    expect(MODEL_TABLES.filter((t) => writes(owner, t))).toEqual([...MODEL_TABLES]);
  });
});
