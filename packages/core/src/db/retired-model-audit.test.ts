/**
 * The audit that hunts the retired release model where the compiler cannot look.
 *
 * `scripts/check-retired-model.mjs` is the deliverable behind criteria 40 and 41: a repository
 * audit that goes red on a source file still reading a binding's `environment` or a project's
 * `productionBranch`. Nothing asserted its behaviour, and a checker whose rules have quietly
 * stopped matching prints the same "no retired release-model reader survives" that a clean
 * repository prints — the two are indistinguishable downstream, which is the exact failure mode
 * conformance rule R7 exists to catch one level up.
 *
 * Every case here is a line that SHOULD match, or a line that must NOT: a rule loose enough to
 * fire on `environment` inside an unrelated identifier is a rule contributors learn to route
 * around.
 */

import { describe, expect, it } from 'vitest';
import { RULES, stripComments } from '../../../../scripts/check-retired-model.mjs';

function hits(source: string): string[] {
  const code = stripComments(source);
  return RULES.filter((r: { id: string; re: RegExp }) => {
    r.re.lastIndex = 0;
    return code.split('\n').some((line) => {
      r.re.lastIndex = 0;
      return r.re.test(line);
    });
  }).map((r: { id: string }) => r.id);
}

describe('the rules name the retired reader', () => {
  it.each([
    ["sql`SELECT 1 FROM integration_bindings b WHERE b.environment = 'prod'`", 'binding-environment-sql'],
    ['sql`... WHERE integration_bindings.environment IS NOT NULL`', 'binding-environment-sql'],
    ['const env = pair.binding.environment;', 'binding-environment-ts'],
    ['if (ctx.environment === "prod") return;', 'binding-environment-ts'],
    ['const b = row.production_branch;', 'production-branch-column'],
    ['const b = project.productionBranch;', 'production-branch-column'],
    ['type Env = "staging" | "prod";', 'inline-environment-union'],
    ['await listActiveBindingsForEnvironment(id);', 'prod-binding-literal'],
    ['const d = await resolveProductionDeclaration(id);', 'prod-binding-literal'],
    ['const c = await resolveReleaseChannel(id);', 'prod-binding-literal'],
  ])('%s → %s', (source, rule) => {
    expect(hits(source)).toContain(rule);
  });
});

describe('the rules leave live code alone', () => {
  it.each([
    "sql`... WHERE b.role = 'deploy' AND 'live' = ANY(b.stages)`",
    'const b = readableLiveBranch(row);',
    'const branch = project.liveBranch;',
    'type Stage = "preview" | "live";',
    // cm:guard the plural. `resolveReleaseChannels` is the replacement and must not be flagged by
    // the rule that retires the singular — a checker that fires on its own remedy is unusable.
    'const set = await resolveReleaseChannels(projectId);',
    'const e = deploymentEnvironment;',
    'const x = environmentOf(binding);',
  ])('%s', (source) => {
    expect(hits(source)).toEqual([]);
  });
});

describe('the comment stripper', () => {
  // cm:guard the defect this lexer replaced. Two regexes could not tell a comment from the same
  // two characters inside a string, so one line carrying both passed the audit — the gate going
  // green on the one input it was written for.
  it('does not let a string containing two slashes hide the rest of its line', () => {
    const line = "const sep = '//'; const b = row.productionBranch;";
    expect(hits(line)).toContain('production-branch-column');
  });

  it('still blanks a real comment, so an obituary is not read as the defect', () => {
    expect(hits('// `production_branch` was renamed by ISS-1046')).toEqual([]);
    expect(hits('/* binding.environment is gone */')).toEqual([]);
  });

  // cm:guard newlines survive a block comment, because the caller reports `i + 1` as the line
  // number: a multi-line comment collapsed to one space renumbers every finding below it, and a
  // cited line number that is wrong is wrong in silence.
  it('preserves the line numbering across a multi-line comment', () => {
    const src = ['const a = 1;', '/*', ' * two', ' * three', ' */', 'const b = 2;'].join('\n');
    expect(stripComments(src).split('\n')).toHaveLength(6);
    expect(stripComments(src).split('\n')[5]).toBe('const b = 2;');
  });

  it('keeps template contents, because one rule reads SQL that only lives in a template', () => {
    expect(stripComments('sql`SELECT b.environment FROM t`')).toContain('b.environment');
  });
});
