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

/** A tool's description names the values a call sends, so a stored value written there is the
 *  contract; its runtime answer is a sentence a caller reads and is held like any other. */
const TOOL_FILE = /^mcp\/tools\//;
/** A line that opens a description: the tool's own, or one a schema field carries. */
const OPENS_DESCRIPTION = /\bdescription:|\.describe\(/;
/** A line holding nothing but a string, which continues the statement above it. */
const STRING_ONLY = /^\s*(?:\+\s*)?['"`]/;

/** A tool file with its description lines blanked, numbering kept, so what is left is the code and
 *  the answers it sends. A string-only line belongs to the statement that opened above it. */
function withoutDescriptions(file: string, source: string): string {
  if (!TOOL_FILE.test(file)) return source;
  let describing = false;
  return source
    .split('\n')
    .map((text) => {
      if (!STRING_ONLY.test(text)) describing = OPENS_DESCRIPTION.test(text);
      return describing ? '' : text;
    })
    .join('\n');
}

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
  [
    'questions/write.ts',
    /this question is \$\{row\.status\}|this question is needs_info/,
    "a question's status, not an issue's",
  ],
  [
    'release-batch/decision-hold.ts',
    /The release ended \$\{toStatus\}/,
    "a release run's status, not an issue's",
  ],
  ['skills/smoke-verify.ts', /`job \$\{row\.status\}`/, "a job's status, not an issue's"],
  [
    'pm/graph-service.ts',
    /const edgeKey = /,
    'a map key built from two issue ids, which no one reads',
  ],
  [
    'integrations/sentry/admission.ts',
    /`status \$\{issue\.status\}`/,
    "a Sentry issue's status, not a Forge issue's",
  ],
  [
    'mcp/tools/forge-issues.ts',
    /throw new Error\(`\$\{status\}: \$\{err\.code\}/,
    'the HTTP status word a tool error leads with',
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
  'issues/release-gate-hold.ts': 'person',
  'issues/release-record-required.ts': 'caller',
  'issues/release-tag-close.ts': 'caller',
  'issues/transition-evidence.ts': 'caller',
  'issues/transition-reason.ts': 'caller',
  'issues/work-state.ts': 'caller',
  'mcp/tools/forge-step-start.ts': 'caller',
  'messaging/claim-rules.ts': 'caller',
  'notifications/notify-transitions.ts': 'person',
  'pipeline/answer-resume.ts': 'person',
  'pipeline/autonomous-dispatch.ts': 'caller',
  'pipeline/autonomous-rescue-comment.ts': 'person',
  'pipeline/idle-issues.ts': 'person',
  'pipeline/issue-run-invariant.ts': 'person',
  'pipeline/outbox-worker.ts': 'person',
  'pipeline/stranded-issues.ts': 'person',
  'pipeline/release-hold.ts': 'person',
  'pipeline/wedge-lease.ts': 'person',
  'pm/dispatch-service.ts': 'caller',
  'projects/stranded-work.ts': 'caller',
  'questions/issue-coupling.ts': 'caller',
  'questions/write.ts': 'caller',
  'release-batch/abort-stamp.ts': 'caller',
  'release-batch/blocker-sentences.ts': 'person',
  'release-batch/carried-sentences.ts': 'person',
  'release-batch/reader-sentences.ts': 'person',
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

/** The lines of the one message a line belongs to: the strings `+` joins up to it. */
function message(lines: string[], i: number): string {
  let start = i;
  while (start > 0 && (lines[start - 1] ?? '').trimEnd().endsWith('+')) start -= 1;
  return lines.slice(start, i + 1).join('\n');
}

/** A caller's file that names a status by its label alone: the value to send back is gone. A label
 *  written again after its pair in the same message, as in "Closed (closed), and Closed means", is
 *  the same status. */
function callerOffences(
  file: string,
  source: string,
  kept: Kept = [...KEPT_LINES, ...PERSON_LINES],
): string[] {
  const lines = source.split('\n');
  const bare = (line: string, i: number) => {
    const label = BARE_LABEL.exec(line)?.[1];
    return label !== undefined && !message(lines, i).includes(`${label} (`);
  };
  return lines
    .map((line, i) => ({ line, i, n: i + 1 }))
    .filter(({ line }) => !isComment(line) && !/^\s*import\b|\bfrom '/.test(line))
    .filter(({ line }) => !kept.some(([f, re]) => f === file && re.test(line)))
    .filter(({ line, i }) => LABEL_ONLY.test(line) || bare(line, i))
    .map(({ line, n }) => `${file}:${n}: ${line.trim().slice(0, 120)}`);
}

/** A label where a status stands in a sentence: "is at Waiting", "a Closed issue". */
const STATUS_WORD = new RegExp(
  `['\`"][^'\`"]*\\b(?:at|is|are|to|from|reach|reaches|off|not|nor|a|an|into|of)\\s+(?:${LABELS})\\b`,
);
/** A file that builds a refusal or an answer a caller reads. */
const REFUSES = /new \w*Error\(|\bdetail:|\brefused\b|code: '[A-Z_]+'/;

type Source = { file: string; source: string };

/** A file that names a status, by a helper or by a label where a status stands, and says nothing
 *  of who reads it. */
function unplaced(sources: Source[]): string[] {
  const names = ({ file, source }: Source) =>
    HELPER.test(source) ||
    (REFUSES.test(source) &&
      source.split('\n').some((line) => !isComment(line) && STATUS_WORD.test(line))) ||
    (TOUCHES_ISSUE_STATUS.test(source) && bareValueOffences(file, source).length > 0);
  return sources
    .filter(names)
    .map(({ file }) => file)
    .filter((file) => !(file in READS));
}

/** A stored value written out in a string a person reads, outside a "Label (value)" pair. */
const STORED_IN_PROSE =
  /['`"][^'`"]*\w\s(?:in_progress|awaiting_release|on_hold|needs_info)\b(?!\))/;

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

/** A status interpolated into a string with no helper naming it, so the reader gets the stored value
 *  alone: `already in status ${requested}`, `Issue is at '${issue.status}'`. */
const BARE_INTERPOLATED =
  /(?<!\\`)\$\{[\w.?]*(?:[sS]tatus|\bfrom|\bto|requested|final|destination|replacement)\}/;
/** The word status followed by a value as stored: `already in status open`. */
const STATUS_THEN_VALUE = new RegExp(`['\`"][^'\`"]*\\bstatus(?:es)?\\s+(?:${STATUSES})\\b(?!\\))`);
/** A query, whose interpolations are parameters and not words anybody reads. */
const SQL_LINE = /\bsql(?:<[^>]*>)?`|^\s*(?:VALUES|AND|OR|WHERE|SELECT|SET|FROM)\b/i;
/** A file that touches an issue's status: by its type, its column, or a row read as `issue`. */
const TOUCHES_ISSUE_STATUS =
  /\bIssueStatus\b|\bissues\.status\b|\bissueStatuses\b|\bissue\??\.status\b/;

/** Lines handing any reader the stored value with nothing beside it: a person wants the label, a
 *  caller the label and then the value to send back. */
function bareValueOffences(file: string, source: string): string[] {
  return source
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !isComment(line) && !SQL_LINE.test(line))
    .filter(({ line }) => !KEPT_LINES.some(([f, re]) => f === file && re.test(line)))
    .filter(
      ({ line }) =>
        BARE_INTERPOLATED.test(line) || STATUS_THEN_VALUE.test(line) || STORED_IN_PROSE.test(line),
    )
    .map(({ line, n }) => `${file}:${n}: ${line.trim().slice(0, 120)}`);
}

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
      .flatMap((file) =>
        offences(file, withoutDescriptions(file, readFileSync(join(SRC, file), 'utf8'))),
      );
    expect(found).toEqual([]);
  });

  const sources = () =>
    walk(SRC)
      .map((full) => relative(SRC, full))
      .filter((file) => file !== SELF && file !== 'issues/status-sets.ts')
      .filter((file) => !CONTRACTS.some(([re]) => re.test(file)))
      .map((file) => ({
        file,
        source: withoutDescriptions(file, readFileSync(join(SRC, file), 'utf8')),
      }));

  it('says who reads every file that names a status', () => {
    expect(unplaced(sources())).toEqual([]);
  });

  // Codex consult on 84d464f: a new refusal naming a label as a literal, with no helper.
  it('refuses a new refusal that names a status by a literal label and says nothing of who reads it', () => {
    const fresh = {
      file: 'issues/new-refusal.ts',
      source:
        "throw new TransitionError('WAITING_KIND', 400, 'a Waiting park must say which kind it is');",
    };
    expect(unplaced([fresh])).toEqual(['issues/new-refusal.ts']);
    const verb = {
      file: 'x/chat.ts',
      source: "throw new Error('No client. Open the desktop app.');",
    };
    expect(unplaced([verb])).toEqual([]);
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

  // Judge-22 at 2734783: NO_OP answered 'issue already in status open', the stored value alone.
  it('writes no status bare into a sentence anybody reads', () => {
    const found = sources()
      .filter(({ file }) => file in READS)
      .flatMap(({ file, source }) => bareValueOffences(file, source));
    expect(found).toEqual([]);
  });

  it('sees a status written bare, by interpolation or in prose', () => {
    const at = (text: string) => bareValueOffences('x.ts', line(text));
    expect(
      at("throw new TransitionError('NO_OP', `issue already in status #{requestedStatus}`, {"),
    ).toHaveLength(1);
    expect(at('  if (!rule) return `issue already in status #{final}`;')).toHaveLength(1);
    expect(
      at("const note = `the driver writes its own status. Issue is at '#{issue.status}'.`;"),
    ).toHaveLength(1);
    expect(at('title: `#{label} moved to #{p.to}`,')).toHaveLength(1);
    expect(at("detail: 'the issue is already in status closed',")).toHaveLength(1);
    expect(at('detail: `issue already in status #{statusForCaller(requestedStatus)}`,')).toEqual(
      [],
    );
    expect(at("detail: 'the issue is already in status Closed (closed)',")).toEqual([]);
    expect(at('  AND status = #{gateStatus}')).toEqual([]);
    expect(at('    status: sql`#{issues.status}`,')).toEqual([]);
  });

  it('asks who reads a file that writes an issue status bare, however the status reached it', () => {
    const inferred = {
      file: 'x/inferred.ts',
      source: line(
        'const issue = await loadIssue(id);\nthrow new Error(`the issue is at #{issue.status}, so nothing moves`);',
      ),
    };
    expect(unplaced([inferred])).toEqual(['x/inferred.ts']);
    const http = {
      file: 'x/http.ts',
      source: line('throw new Error(`GitHub answered HTTP #{res.status}`);'),
    };
    expect(unplaced([http])).toEqual([]);
  });

  it("holds a tool's runtime answer and leaves its description the contract it is", () => {
    const tool = sources().find(({ file }) => file === 'mcp/tools/forge-step-start.ts');
    expect(tool && READS[tool.file]).toBe('caller');
    const file = 'mcp/tools/forge-x.ts';
    const description = [
      '  description:',
      "    'Moves the issue. `toStatus` takes `awaiting_release` or ' +",
      "    '`closed`, and the answer says which.',",
      "  status: z.enum(issueStatuses).describe('`needs_info` parks it'),",
    ].join('\n');
    expect(offences(file, withoutDescriptions(file, description))).toEqual([]);
    // Codex review of f556a27: a runtime answer in code form was exempt with its whole file.
    const answer = line('    throw new Error(`Issue is at \\`#{issue.status}\\``);');
    const both = withoutDescriptions(file, [description, answer].join('\n'));
    expect(offences(file, both)).toHaveLength(1);
    const split = line(
      [
        '    const note =',
        "      `the driver writes its own status. Issue is at '#{issue.status}'.`;",
      ].join('\n'),
    );
    expect(bareValueOffences(file, withoutDescriptions(file, split))).toHaveLength(1);
    expect(unplaced([{ file, source: withoutDescriptions(file, split) }])).toEqual([file]);
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
    const two = ["one: 'a Waiting (waiting) park asks',", "two: 'a Waiting park says',"].join('\n');
    expect(callerOffences('x.ts', two)).toHaveLength(1);
    const joined = [
      "'this issue is Closed (closed), and ' +",
      "'Closed means the work shipped'",
    ].join('\n');
    expect(callerOffences('x.ts', joined)).toEqual([]);
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
