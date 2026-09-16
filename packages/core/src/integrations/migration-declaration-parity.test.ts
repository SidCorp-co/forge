/**
 * `0255` and its rollback classify every provider by agent path, and the registry declares the
 * same thing. Nothing else notices when the two disagree.
 *
 * ISS-1071 criterion 44. The migration cannot import the registry — it is SQL, applied by a
 * container that has already replaced the code — so it carries the classification as a literal
 * `VALUES` list, and that list is a second copy of `capabilities.agentPath.kind`. The forward file
 * refuses a provider it cannot classify, which covers a provider ADDED after it; what nothing
 * covered is a provider whose declared kind CHANGES, because then the migration classifies it
 * confidently and wrongly, and a binding is granted or withheld against a rule nobody meant.
 *
 * The rollback carries its own copy for a harder reason: the forward file DROPS
 * `iss1071_provider_agent_path` at the end, so the table is not there to read on the way back. Both
 * copies are checked here, against each other and against the registry, because a renumber or an
 * edit that touches one is exactly the moment the other is forgotten.
 *
 * Read as TEXT, deliberately: the point is what the SQL a database will execute actually says, not
 * what a TypeScript mirror of it says.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerAllIntegrations } from './register-all.js';
import { listIntegrations } from './registry.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Found by what the file SAYS, never by its index.
 *
 * The first version of this test opened `0255_*.sql` by name, and a rebase past another wave's
 * migration renumbered it to `0259` two hours later — so the test that exists to catch silent drift
 * went red for the one reason that is not drift. An index is positional: it says "one slot above
 * whatever was highest when this was written" and moves at every rebase. The table names do not,
 * which is also how `tests/integration/mcp-sentinel-migration.fixture.ts` finds the same two files.
 */
function byMarker(dir: string, marker: string): string {
  const full = join(HERE, dir);
  const hits = readdirSync(full)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => readFileSync(join(full, f), 'utf8').includes(marker));
  const only = hits[0];
  if (hits.length !== 1 || !only) {
    throw new Error(`expected exactly one .sql in ${dir} naming ${marker}, found ${hits.length}`);
  }
  return join(full, only);
}

const FORWARD = byMarker('../../drizzle/migrations', 'iss1071_provider_agent_path');
const ROLLBACK = byMarker('../../drizzle/rollback', 'iss1071_agent_access_set');

/**
 * Every `('<provider>', '<kind>')` pair in a file, comment lines removed first.
 *
 * Both files spell the pairs the same way, and both keep prose beside them — the forward file
 * explains why `agent` is `none`, the rollback why it holds a copy at all — so a naive scan would
 * read a provider name out of a sentence and compare it to nothing.
 */
function declaredPairs(file: string, start: RegExp): Record<string, string> {
  const sql = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  const at = sql.search(start);
  if (at < 0) throw new Error(`no provider/kind VALUES block in ${file} — did a rename move it?`);
  // Only as far as the statement's end. Both files carry other two-string tuples — the column's
  // own CHECK is `('none', 'all')` — and a scan of the whole file reads those as providers.
  const block = sql.slice(at, sql.indexOf(';', at));
  const pairs: Record<string, string> = {};
  for (const [, provider, kind] of block.matchAll(/\(\s*'([a-z]+)'\s*,\s*'([a-z-]+)'\s*\)/g)) {
    if (provider && kind) pairs[provider] = kind;
  }
  if (Object.keys(pairs).length === 0) throw new Error(`no pairs parsed from ${file}`);
  return pairs;
}

const FORWARD_BLOCK = /INSERT INTO iss1071_provider_agent_path \(provider, kind\) VALUES/;
const ROLLBACK_BLOCK = /LEFT JOIN \(VALUES/;

let declared: Record<string, string>;

beforeAll(() => {
  registerAllIntegrations();
  declared = Object.fromEntries(
    listIntegrations().map((d) => [d.provider, d.capabilities.agentPath.kind]),
  );
});

describe('the migration classifies every provider the way its declaration does', () => {
  it('the forward migration names exactly the registry, with the same kind for each', () => {
    expect(declaredPairs(FORWARD, FORWARD_BLOCK)).toEqual(declared);
  });

  it('the rollback carries the same table, because the forward run drops the real one', () => {
    expect(declaredPairs(ROLLBACK, ROLLBACK_BLOCK)).toEqual(declared);
  });

  // A kind the SQL does not know is worse than an unknown provider: the forward file refuses a
  // provider missing from its list, but a value outside these three flows through its CASE arms as
  // "not core-mediated, not direct-mcp" and is silently treated as having no agent path.
  it('uses only the three kinds the model has, on both sides', () => {
    for (const [file, block] of [
      [FORWARD, FORWARD_BLOCK],
      [ROLLBACK, ROLLBACK_BLOCK],
    ] as const) {
      for (const kind of Object.values(declaredPairs(file, block))) {
        expect(['core-mediated', 'direct-mcp', 'none']).toContain(kind);
      }
    }
  });
});
