import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { issueStatuses } from '../db/schema.js';
import { ISSUE_STATUS_LABELS, statusLabel } from './status-sets.js';

/**
 * ISS-1229 r5 — a refusal or a sentence a person reads names an issue status by the label the
 * screen shows (Awaiting release), never as the stored value in code (`awaiting_release`). Shape &
 * release drew `testing` and `awaiting_release` as code beside a link reading "Awaiting release".
 */

const SRC = new URL('..', import.meta.url).pathname;
const SELF = 'issues/reader-status-words.test.ts';

/** Where the stored value IS the text: what an agent or API caller sends, not what a person reads. */
const CONTRACTS: Array<[RegExp, string]> = [
  [/^prompt\//, 'agent prompts and prompt facts name the value a transition sends'],
  [/^mcp\/tools\//, 'tool descriptions name the value a tool call sends'],
  [/^guides\//, 'the guides are written for agents and name the values they send'],
  [/^assistant\//, 'the assistant prompt names the values its tools send'],
  [
    /routes-reference\.ts$|^issues\/transition-reference\.ts$/,
    'API reference: the values a request body takes',
  ],
  [
    /^pipeline\/pipeline-config-schema\.ts$/,
    'the config schema names the values a config write takes',
  ],
  [/^release-batch\/prompt\.ts$/, 'the release agent prompt'],
];

/** Lines a reader sees that keep the stored value, each for a stated reason. */
const KEPT_LINES: Array<[string, RegExp, string]> = [
  [
    'issues/transition-reason.ts',
    /moved from \\`\$\{from\}\\`|Reopened from \\`\$\{from\}\\`|\*\*→ \\`\$\{toStatus\}\\`\*\*/,
    'the transition heading is a wire format: forge-plugin reads "— moved from `<status>`" (earned.mjs ANNOUNCED) to find the park that set a status',
  ],
  [
    'projects/stranded-work.ts',
    /kind from \\`\$\{args\.from\}\\` to \\`\$\{args\.to\}\\`/,
    'a project kind, not an issue status',
  ],
];

const STATUSES = issueStatuses.join('|');
/** A status literal in code, in a plain string or escaped inside a template. */
const LITERAL = new RegExp(`\\\\?\`(?:${STATUSES})\\\\?\``);
/** An interpolated value named as a status, in code inside a template. */
const INTERPOLATED =
  /\\`\$\{[\w.?]*(?:[sS]tatus|STATUS(?:ES\[\d+\])?|\bfrom|\bto|requested|final|destination|left|replacement|ASKS_WITH_NEEDS)\}\\`|(?:STATUSES|TARGETS)\.map\(\(\w+\) => `\\`\$\{\w+\}\\``\)/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.ts') && !/\.(test|fixture)\.ts$/.test(name)) out.push(full);
  }
  return out;
}

function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

function offences(file: string, source: string): string[] {
  return source
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !isComment(line) && (LITERAL.test(line) || INTERPOLATED.test(line)))
    .filter(({ line }) => !KEPT_LINES.some(([f, re]) => f === file && re.test(line)))
    .map(({ line, n }) => `${file}:${n}: ${line.trim().slice(0, 120)}`);
}

describe('a status a person reads is named by its label (ISS-1229)', () => {
  it('no refusal or reader sentence in core writes a status as code', () => {
    const found = walk(SRC)
      .map((full) => relative(SRC, full))
      .filter((file) => file !== SELF && !CONTRACTS.some(([re]) => re.test(file)))
      .flatMap((file) => offences(file, readFileSync(join(SRC, file), 'utf8')));
    expect(found).toEqual([]);
  });

  /** A source line as the scan reads it; `#{` stands for an interpolation's opening. */
  const line = (text: string) => text.replaceAll('#{', `${'$'}{`);

  it.each([
    ['a status literal in a plain string', "'issue is at `awaiting_release`'"],
    ['a status literal escaped in a template', '`it rests at \\`awaiting_release\\` until`'],
    ['an interpolated status', '`it stands at \\`#{row.status}\\``'],
    ['an interpolated from-status', '`moved from \\`#{args.from}\\` on`'],
    ['a status constant', '`handed an issue at \\`#{AUTONOMOUS_ENTRY_STATUS}\\`, this one`'],
    ['a replacement status', '`Write \\`#{replacement}\\` instead`'],
    [
      'a list of statuses mapped into code',
      "`it may move to #{DRAFT_EXIT_TARGETS.map((s) => `\\`#{s}\\``).join(', ')}`",
    ],
  ])('the scan sees %s', (_name, source) => {
    expect(offences('x.ts', line(source))).toHaveLength(1);
  });

  it('lets a status written as its label through', () => {
    expect(offences('x.ts', line('`it rests at #{statusLabel(row.status)} until`'))).toEqual([]);
  });

  it('labels every status, and shows one this build does not know as stored', () => {
    for (const s of issueStatuses) expect(statusLabel(s)).toBe(ISSUE_STATUS_LABELS[s]);
    expect(statusLabel('somewhere_new')).toBe('somewhere_new');
  });
});
