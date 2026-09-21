import { describe, expect, it } from 'vitest';
import {
  type RetiredModelRule,
  RULES,
  stripComments,
} from '../../../../scripts/check-retired-model.mjs';

function hits(source: string): string[] {
  const code = stripComments(source);
  return RULES.filter((r: RetiredModelRule) => {
    r.re.lastIndex = 0;
    return code.split('\n').some((line) => {
      r.re.lastIndex = 0;
      return r.re.test(line);
    });
  }).map((r) => r.id);
}

describe('the rules name the retired reader', () => {
  it.each([
    [
      "sql`SELECT 1 FROM integration_bindings b WHERE b.environment = 'prod'`",
      'binding-environment-sql',
    ],
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
    'const set = await resolveReleaseChannels(projectId);',
    'const e = deploymentEnvironment;',
    'const x = environmentOf(binding);',
  ])('%s', (source) => {
    expect(hits(source)).toEqual([]);
  });
});

describe('the comment stripper', () => {
  it('does not let a string containing two slashes hide the rest of its line', () => {
    const line = "const sep = '//'; const b = row.productionBranch;";
    expect(hits(line)).toContain('production-branch-column');
  });

  it('still blanks a real comment, so an obituary is not read as the defect', () => {
    expect(hits('// `production_branch` was renamed by ISS-1046')).toEqual([]);
    expect(hits('/* binding.environment is gone */')).toEqual([]);
  });

  it('preserves the line numbering across a multi-line comment', () => {
    const src = ['const a = 1;', '/*', ' * two', ' * three', ' */', 'const b = 2;'].join('\n');
    expect(stripComments(src).split('\n')).toHaveLength(6);
    expect(stripComments(src).split('\n')[5]).toBe('const b = 2;');
  });

  it('keeps template contents, because one rule reads SQL that only lives in a template', () => {
    expect(stripComments('sql`SELECT b.environment FROM t`')).toContain('b.environment');
  });

  it('re-enters code inside a template substitution, so a nested template hides nothing', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the `${` IS the input under test — source text handed to the lexer, never a template the runtime should interpolate.
    const line = 'const s = `${`//`}`; const b = row.productionBranch;';
    expect(stripComments(line)).toBe(line);
    expect(hits(line)).toContain('production-branch-column');
  });

  it('closes a substitution on its own brace, so a comment inside one is still blanked', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: same reason as above — the `${` is the lexer's input, not an interpolation this file wants performed.
    const line = 'const q = `${ cfg({a: 1}) /* row.productionBranch was renamed */ }`;';
    expect(stripComments(line)).not.toContain('row.productionBranch');
    expect(hits(line)).toEqual([]);
  });
});
