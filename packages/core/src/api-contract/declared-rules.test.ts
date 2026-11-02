import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// @direct-test-of packages/core/src/middleware/declared-permission.ts
// A route or action declared by a named rule (requiresByRule, byRule; ISS-824) names the code that
// decides who may, as `<file under src>:<exported function>`. Each name in the published contracts
// must point at an exported function that exists, so a rename or a move goes red here, not silent.

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(CORE, 'src');
const CONTRACTS = ['forge-api.openapi.json', 'forge-mcp.tools.json'];

/** Why `rule` points at no exported function, or null where it does. */
function ruleRefusal(rule: string): string | null {
  const m = /^([\w./-]+\.ts):([A-Za-z_$][\w$]*)$/.exec(rule);
  if (!m) return `${rule}: not \`<file under src>:<exported function>\``;
  const [, file, symbol] = m as unknown as [string, string, string];
  const where = join(SRC, file);
  if (!existsSync(where)) return `${rule}: src/${file} does not exist`;
  const exported = new RegExp(
    `export\\s+(?:async\\s+)?(?:function\\*?\\s+|const\\s+|let\\s+)${symbol.replace('$', '\\$')}\\b`,
  );
  return exported.test(readFileSync(where, 'utf8'))
    ? null
    : `${rule}: src/${file} exports no function ${symbol}`;
}

function rulesIn(node: unknown, inPermission: boolean, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) rulesIn(item, inPermission, out);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  if (inPermission && typeof record.rule === 'string') out.add(record.rule);
  for (const [key, value] of Object.entries(record)) {
    rulesIn(value, inPermission || key === 'x-forge-permission', out);
  }
}

const declaredRules = (): string[] => {
  const out = new Set<string>();
  for (const name of CONTRACTS) {
    rulesIn(JSON.parse(readFileSync(join(CORE, 'contracts', name), 'utf8')), false, out);
  }
  return [...out].sort();
};

describe('every rule a declaration names is real code', () => {
  it('points each published rule name at an exported function', () => {
    expect(
      declaredRules()
        .map(ruleRefusal)
        .filter((r) => r !== null),
    ).toEqual([]);
  });

  it('refuses a name with no file, no export, or the wrong shape', () => {
    expect(ruleRefusal('nowhere/missing.ts:f')).toMatch(/does not exist/);
    expect(ruleRefusal('permissions/declared.ts:noSuchRule')).toMatch(/exports no function/);
    expect(ruleRefusal('channel-hold')).toMatch(/not `<file under src>/);
    expect(ruleRefusal('permissions/declared.ts:enforceDeclared')).toBeNull();
  });
});
