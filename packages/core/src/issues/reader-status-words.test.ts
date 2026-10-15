import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { issueStatuses } from '../db/schema.js';
import { ISSUE_STATUS_LABELS, statusForCaller, statusLabel } from './status-sets.js';

/**
 * ISS-1229 r5 — no status is written as code. A sentence a person reads (a screen, a notice, a
 * comment) names it by its label: Awaiting release. A refusal an agent or API caller reads names
 * the label AND the value it sends back: Awaiting release (awaiting_release). r5d labelled
 * TRANSITION_REASON_REQUIRED alone and an agent could no longer read which status to send.
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
  [
    /^issues\/dependency-effects\.ts$/,
    'the edge notes forge_pm_set_dependency, forge_project_pm and the dependency guide carry',
  ],
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

/** Who reads the sentences a file builds through `statusLabel` or `statusForCaller`. A file new to
 *  either helper is refused until it is placed here. */
const READS: Record<string, 'person' | 'caller'> = {
  'integrations/github/check-run-body.ts': 'person',
  'integrations/sentry/intake-issue.ts': 'caller',
  'issues/apply-transition.ts': 'caller',
  'issues/archive.ts': 'caller',
  'issues/close-substitution.ts': 'caller',
  'issues/landing-evidence.ts': 'caller',
  'issues/merge-marker.ts': 'caller',
  'issues/merged-at.ts': 'caller',
  'issues/park-question.ts': 'caller',
  'issues/park-view.ts': 'person',
  'issues/release-record-required.ts': 'caller',
  'issues/release-tag-close.ts': 'caller',
  'issues/transition-evidence.ts': 'caller',
  'issues/transition-reason.ts': 'caller',
  'issues/work-state.ts': 'caller',
  'pipeline/answer-resume.ts': 'person',
  'pipeline/autonomous-dispatch.ts': 'caller',
  'pipeline/autonomous-rescue-comment.ts': 'person',
  'pipeline/idle-issues.ts': 'person',
  'pipeline/wedge-lease.ts': 'person',
  'pm/dispatch-service.ts': 'caller',
  'projects/stranded-work.ts': 'caller',
  'questions/issue-coupling.ts': 'caller',
  'questions/write.ts': 'caller',
  'release-batch/abort-stamp.ts': 'caller',
  'release-batch/blocker-sentences.ts': 'person',
  'release-batch/claim-conflicts.ts': 'caller',
  'release-batch/releasing-recovery.ts': 'person',
};

const HELPER = /\bstatus(?:Label|ForCaller)\b/;
const LABEL_ONLY = /\bstatusLabel\b/;

const LABELS = Object.values(ISSUE_STATUS_LABELS).join('|');
/** A label in a string, not followed by the value in parentheses. */
const BARE_LABEL = new RegExp(`['\`"][^'\`"]*\\b(${LABELS})\\b(?! \\()`);

type Kept = Array<[string, RegExp, string]>;

/** Lines in a caller's file that only a person reads, so the label alone is right there. A sentence
 *  both read takes the pair. */
const PERSON_LINES: Kept = [];

/** A caller's file that names a status by its label alone: the value to send back is gone. A label
 *  written again after its pair, as in "Closed (closed), and Closed means", is the same status. */
function callerOffences(
  file: string,
  source: string,
  kept: Kept = [...KEPT_LINES, ...PERSON_LINES],
): string[] {
  const bare = (line: string) => {
    const label = BARE_LABEL.exec(line)?.[1];
    return label !== undefined && !source.includes(`${label} (`);
  };
  return source
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !isComment(line) && !/^\s*import\b|\bfrom '/.test(line))
    .filter(({ line }) => !kept.some(([f, re]) => f === file && re.test(line)))
    .filter(({ line }) => LABEL_ONLY.test(line) || bare(line))
    .map(({ line, n }) => `${file}:${n}: ${line.trim().slice(0, 120)}`);
}

/** A stored value written out in a string a person reads, outside a "Label (value)" pair. */
const STORED_IN_PROSE =
  /['`"][^'`"]*(?<![.(\w])(?:in_progress|awaiting_release|on_hold|needs_info)\b(?!\))/;

function personOffences(file: string, source: string): string[] {
  return source
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !isComment(line) && STORED_IN_PROSE.test(line))
    .filter(({ line }) => !KEPT_LINES.some(([f, re]) => f === file && re.test(line)))
    .map(({ line, n }) => `${file}:${n}: ${line.trim().slice(0, 120)}`);
}

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

  const sources = () =>
    walk(SRC)
      .map((full) => relative(SRC, full))
      .filter((file) => file !== SELF && file !== 'issues/status-sets.ts')
      .filter((file) => !CONTRACTS.some(([re]) => re.test(file)))
      .map((file) => ({ file, source: readFileSync(join(SRC, file), 'utf8') }));

  it('says who reads every file that names a status through a helper', () => {
    const unplaced = sources()
      .filter(({ source }) => HELPER.test(source))
      .map(({ file }) => file)
      .filter((file) => !(file in READS));
    expect(unplaced).toEqual([]);
  });

  it('names the value a caller sends back wherever a caller reads the sentence', () => {
    const found = sources()
      .filter(({ file }) => READS[file] === 'caller')
      .flatMap(({ file, source }) => callerOffences(file, source));
    expect(found).toEqual([]);
  });

  it('names no stored value in prose a person reads', () => {
    const found = sources()
      .filter(({ file }) => READS[file] === 'person')
      .flatMap(({ file, source }) => personOffences(file, source));
    expect(found).toEqual([]);
  });

  // The codex consult on the r5e plan: one file can hold a notice and a refusal, and one sentence
  // can serve both readers.
  it('holds a file that writes a notice and a refusal to each rule', () => {
    const notice = "body: 'The issue is back at Testing, where the next dispatch takes it up.',";
    const refusal =
      'detail: `a transition to ' + '$' + '{statusForCaller(to)} must carry a reason`,';
    const asNotice: Kept = [['mixed.ts', /is back at Testing/, 'a comment on the issue']];
    expect(callerOffences('mixed.ts', [notice, refusal].join('\n'), asNotice)).toEqual([]);
    expect(callerOffences('mixed.ts', [notice, refusal].join('\n'), [])).toHaveLength(1);
    expect(
      personOffences('x.ts', "body: 'it rests at awaiting_release until a tag holds it',"),
    ).toHaveLength(1);
    expect(
      personOffences('x.ts', "body: 'it rests at Awaiting release (awaiting_release)',"),
    ).toEqual([]);
  });

  it('sees a caller sentence that names a status by its label alone', () => {
    const line =
      'detail: `a transition to ' + '$' + '{statusLabel(requestedStatus)} must carry a reason`,';
    expect(callerOffences('x.ts', line)).toHaveLength(1);
    expect(callerOffences('x.ts', line.replace('statusLabel', 'statusForCaller'))).toEqual([]);
    expect(
      callerOffences('x.ts', "detail: 'a Waiting park must say which kind it is',"),
    ).toHaveLength(1);
    expect(
      callerOffences('x.ts', "detail: 'a Waiting (waiting) park must say which kind',"),
    ).toEqual([]);
  });

  it('gives a caller the label and the value it sends', () => {
    expect(statusForCaller('awaiting_release')).toBe('Awaiting release (awaiting_release)');
    expect(statusForCaller('on_hold')).toBe('On hold (on_hold)');
    expect(statusForCaller('somewhere_new')).toBe('somewhere_new');
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
