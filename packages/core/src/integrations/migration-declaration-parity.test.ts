import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerAllIntegrations } from './register-all.js';
import { listIntegrations } from './registry.js';

const HERE = dirname(fileURLToPath(import.meta.url));

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

const MOVED_SINCE_0259: Record<string, { was: string; issue: string }> = {
  // ISS-1074 gave github an agent path — `core-mediated`, reached through `forge_github`. 0259 keeps
  // `none`: its core-mediated arm force-grants `all` on the ground that those tools were ungated
  // already, and `forge_github` never was, so classifying github there would open every binding.
  github: { was: 'none', issue: 'ISS-1074' },
};

let declared: Record<string, string>;

/** What 0259 should say: the registry, with each moved provider held at the kind 0259 recorded. */
function asOfMigration(current: Record<string, string>): Record<string, string> {
  const out = { ...current };
  for (const [provider, moved] of Object.entries(MOVED_SINCE_0259)) {
    if (provider in out) out[provider] = moved.was;
  }
  return out;
}

beforeAll(() => {
  registerAllIntegrations();
  declared = Object.fromEntries(
    listIntegrations().map((d) => [d.provider, d.capabilities.agentPath.kind]),
  );
});

describe('the migration classifies every provider the way its declaration does', () => {
  it('the forward migration names exactly the registry, with the same kind for each', () => {
    expect(declaredPairs(FORWARD, FORWARD_BLOCK)).toEqual(asOfMigration(declared));
  });

  it('the rollback carries the same table, because the forward run drops the real one', () => {
    expect(declaredPairs(ROLLBACK, ROLLBACK_BLOCK)).toEqual(asOfMigration(declared));
  });

  // The other half of the allowance, and the one that keeps it from becoming a licence: an entry
  // whose provider now declares the very kind 0259 gave it is an entry describing a drift that no
  // longer exists, and it would silently excuse the next real one.
  it('names no provider that has not actually moved', () => {
    for (const [provider, moved] of Object.entries(MOVED_SINCE_0259)) {
      expect(declared, `${provider} is not in the registry at all`).toHaveProperty(provider);
      expect(
        declared[provider],
        `${provider} declares ${declared[provider]}, which is what 0259 already says — delete its MOVED_SINCE_0259 entry (${moved.issue})`,
      ).not.toBe(moved.was);
    }
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
