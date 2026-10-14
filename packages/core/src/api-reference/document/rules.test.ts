import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Finding } from './build.js';
import { RULES } from './rules.js';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** The rules with no test titled `<rule>:`, the way each planted case in the check's tests is. */
function unplanted(rules: readonly string[], testText: string): string[] {
  return rules.filter((rule) => !new RegExp(`it\\(\\s*['"\`]${rule}:`).test(testText));
}

const checkTests = ['../document', '../gates']
  .flatMap((dir) =>
    readdirSync(here(dir))
      .filter((file) => file.endsWith('.test.ts') && file !== 'rules.test.ts')
      .map((file) => readFileSync(here(`${dir}/${file}`), 'utf8')),
  )
  .join('\n');

describe('every rule the check can name is planted', () => {
  it('has a test titled for each rule of the registry the build and the check write findings from', () => {
    expect(RULES.length).toBeGreaterThanOrEqual(16);
    expect(unplanted(RULES, checkTests)).toEqual([]);
  });

  it('names a rule a source writes some other way than as a literal, because it reads the registry', () => {
    const written = ['no', 'access'].join('-');
    expect(unplanted([...RULES, 'never-planted-rule', written], checkTests)).toEqual([
      'never-planted-rule',
    ]);
  });

  it('is red for a registered rule whose test was renamed away from its title', () => {
    expect(
      unplanted(['unread-chain'], checkTests.replaceAll("it('unread-chain:", "it('unread chain:")),
    ).toEqual(['unread-chain']);
  });

  it('refuses at compile time a finding whose rule is not in the registry', () => {
    // @ts-expect-error a rule outside RULES is not a Finding, however it is spelled
    const finding: Finding = { rule: 'a-rule-nobody-registered', route: 'GET /x', detail: 'd' };
    expect(RULES.includes(finding.rule)).toBe(false);
  });
});
