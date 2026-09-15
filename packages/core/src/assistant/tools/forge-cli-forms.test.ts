/**
 * ISS-1041 — the read forms carried in the `forge` tool's description are held
 * to the bundled CLI's own `-h`, whole form by whole form.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({ env: {} }));

import { formProblems, parseUsage, READ_FORMS, readFormsLine } from './forge-cli-forms.js';
import { forgeCliTool } from './forge-cli-tool.js';
import { DESCRIPTION_CAP } from './mcp-adapter.js';

const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve('forge-plugin/package.json')), 'plugin', 'src', 'cli.mjs');
const usageOf = (verb: string): string =>
  execFileSync(process.execPath, [cli, verb, '-h'], { encoding: 'utf8', timeout: 20_000 })
    .split('\n')
    .find((l) => l.startsWith('Usage:')) ?? '';

describe('the carried read forms against the bundled CLI (criterion 14)', () => {
  for (const form of READ_FORMS) {
    it(`\`forge ${form.argv.join(' ')}\` fits \`forge ${form.argv[0]} -h\``, () => {
      const usage = usageOf(form.argv[0] as string);
      expect(usage).toMatch(/^Usage: forge/);
      expect(formProblems(form, parseUsage(usage))).toEqual([]);
    });
  }

  // cm:guard the test can go red on the three kinds of drift a flag-presence check misses: a flag gone, a flag whose operand arity changed, a positional the verb no longer takes.
  it('refuses a form whose flag, operand or positional the Usage line no longer names', () => {
    const noSearch = parseUsage('Usage: forge issue [<uuid|ISS-45>] [--status s] [--limit n]');
    expect(formProblems({ argv: ['issue', '--search', '<q>'], says: '' }, noSearch)).toEqual([
      '--search is not in the Usage line',
    ]);
    const flagOnly = parseUsage('Usage: forge issue [--status] [--limit n]');
    expect(formProblems({ argv: ['issue', '--status', '<s>'], says: '' }, flagOnly)).toEqual([
      '--status takes none in the Usage line',
    ]);
    const noPositional = parseUsage('Usage: forge guide [--for ISS-nn]');
    expect(formProblems({ argv: ['guide', '<slug>'], says: '' }, noPositional)).toEqual([
      '1 positional(s) carried, Usage line takes 0',
    ]);
  });

  // cm:guard a REQUIRED positional or a literal subcommand the Usage line grows is drift the carried form must fail on, not an upper bound it slips under (codex F2).
  it('refuses a form that misses a required positional or a literal subcommand', () => {
    const show = parseUsage('Usage: forge issue show <uuid> [--full]');
    expect(formProblems({ argv: ['issue', 'ISS-<n>'], says: '' }, show)).toEqual([
      'positional #1 must be the word `show`, not `ISS-<n>`',
      'required positional #2 is not carried',
    ]);
    const twoRequired = parseUsage('Usage: forge guide <slug> <part>');
    expect(formProblems({ argv: ['guide', '<slug>'], says: '' }, twoRequired)).toEqual([
      'required positional #2 is not carried',
    ]);
    const alternatives = parseUsage(
      'Usage: forge guide [contract [part]|<skill> [reference]|slug] [--for ISS-nn]',
    );
    expect(alternatives.positionals).toEqual([{ required: false, literal: null }]);
    expect(formProblems({ argv: ['guide', '<slug>'], says: '' }, alternatives)).toEqual([]);
    const optionalOnly = parseUsage('Usage: forge issue [<uuid|ISS-45>] [--status s]');
    expect(optionalOnly.positionals).toEqual([{ required: false, literal: null }]);
    expect(optionalOnly.options.get('--status')).toBe(true);
  });
});

describe('the forge tool description', () => {
  const tool = forgeCliTool({
    principal: { userId: 'u' },
    boundProjectId: 'p',
    projectSlug: 'acme',
  } as never);

  it('names the four read forms (criterion 13)', () => {
    for (const form of [
      'issue --status <s> --limit <n>',
      'issue ISS-<n>',
      'issue --search <q>',
      'guide <slug>',
    ]) {
      expect(tool.description).toContain(`\`${form}\``);
    }
    expect(tool.description).toContain(readFormsLine());
  });

  it('stays under DESCRIPTION_CAP (criterion 15)', () => {
    expect(tool.description.length).toBeLessThan(DESCRIPTION_CAP);
  });
});
