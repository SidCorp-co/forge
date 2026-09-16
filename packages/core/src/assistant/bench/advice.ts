/**
 * ISS-1058 — the advice block: what the numbers a comparison already prints ask of the harness,
 * one line per pattern over its threshold, each naming the count it rests on, the bar it crossed
 * and the `file.ts:symbol` it points at. Derived from the mode counts and the judge column only:
 * no model, no write, and no count is changed. A missing verdict is never evidence that a
 * safeguard is too strict — an unjudged screen row asks for a judge, not for a looser screen — and a
 * judged `yes` on a screen row is read for what it is: the judge saw the repaired reply, never the
 * one the screen rejected (codex F1, F2 on the plan).
 */

import type { FailureMode } from './grade.js';
import type { HistoryResult } from './history/result.js';
import { isVerdict, type Served } from './judge.js';
import type { BenchResult } from './result.js';

export interface AdviceInput {
  /** The task id or the `model / source` group the counts belong to. */
  label: string;
  /** Rows (turns or chat_logs rows) the counts are over. */
  rows: number;
  /**
   * Every row that failed a rule: its modes and the judge's `served` on it, null where no readable
   * verdict exists. A row is counted once per pattern however many of its modes match.
   */
  flagged: ReadonlyArray<FlaggedInput>;
}

export interface FlaggedInput {
  modes: readonly FailureMode[];
  served: Served | null;
}

export interface AdviceLine {
  label: string;
  pattern: string;
  count: number;
  rows: number;
  threshold: string;
  surface: string;
  change: string;
}

/** The bars a pattern must cross before it is named; each has a test. */
export const THRESHOLDS = {
  /** Help roundtrips above this share of rows name the tool layer. */
  helpRoundtripShare: 0.1,
} as const;

const SCREEN_MODES: readonly FailureMode[] = ['screen_repair', 'fallback_sent'];
const LINK_MODES: readonly FailureMode[] = ['wrong_link_shape', 'dead_link'];
const LOOP_MODES: readonly FailureMode[] = ['over_budget', 'repeated_call'];

const SCREEN_SURFACE = 'conversations/screened-reply.ts:screenReply';

/** The rows carrying any of the modes: one row, one count, however many of its modes match. */
const withModes = (input: AdviceInput, modes: readonly FailureMode[]): FlaggedInput[] =>
  input.flagged.filter((row) => row.modes.some((m) => modes.includes(m)));
const rowsWith = (input: AdviceInput, modes: readonly FailureMode[]): number =>
  withModes(input, modes).length;

const line = (
  input: AdviceInput,
  pattern: string,
  count: number,
  threshold: string,
  surface: string,
  change: string,
): AdviceLine => ({
  label: input.label,
  pattern,
  count,
  rows: input.rows,
  threshold,
  surface,
  change,
});

/**
 * The screen, in three subsets of its rows, each counted on its own: rows without a readable
 * verdict ask for a judge; rows the judge called served say the repair served and send the reader
 * to the rejected attempt; rows the judge called `no` say the repair did not serve either.
 * A screen_repair row's verdict is on the repaired reply (`history/grade-row.ts:gradeRow` marks
 * the retry row; a run turn's delivered text is the last attempt), so no verdict on it can say the
 * rejected reply should have been accepted.
 */
function screenAdvice(input: AdviceInput): AdviceLine[] {
  const rows = withModes(input, SCREEN_MODES);
  if (rows.length === 0) return [];
  const pattern = 'screen_repair/fallback_sent';
  const unjudged = rows.filter((r) => r.served === null).length;
  const served = rows.filter((r) => r.served === 'yes' || r.served === 'partial').length;
  const no = rows.filter((r) => r.served === 'no').length;
  const out: AdviceLine[] = [];
  if (unjudged > 0)
    out.push(
      line(
        input,
        pattern,
        unjudged,
        'above 0, unjudged',
        'bench:assistant run --judge / history --judge',
        'the screen rejected replies and nothing says whether they were right; judge these rows before touching the screen',
      ),
    );
  if (served > 0)
    out.push(
      line(
        input,
        pattern,
        served,
        'above 0, repaired reply judged yes/partial',
        SCREEN_SURFACE,
        'the repair served; the verdict is on the repaired reply, not the rejected one - read the rejected attempt in the row, and loosen the shape check only where it answered the question',
      ),
    );
  if (no > 0)
    out.push(
      line(
        input,
        pattern,
        no,
        'above 0, repaired reply judged no',
        SCREEN_SURFACE,
        'the repair did not serve either; the fault is upstream of the screen, keep it',
      ),
    );
  return out;
}

/** Every line the counts of one task or group call for. */
export function advise(inputs: readonly AdviceInput[]): AdviceLine[] {
  const out: AdviceLine[] = [];
  for (const input of inputs) {
    if (input.rows === 0) continue;
    out.push(...screenAdvice(input));
    const help = rowsWith(input, ['help_roundtrip']);
    if (help / input.rows > THRESHOLDS.helpRoundtripShare)
      out.push(
        line(
          input,
          'help_roundtrip',
          help,
          `above ${Math.round(THRESHOLDS.helpRoundtripShare * 100)}%`,
          'guides/assistant-method-guide.ts:ASSISTANT_METHOD_GUIDE',
          "the method guide sends the model to -h for every verb; carry the verbs' usage so no -h call is needed",
        ),
      );
    const links = rowsWith(input, LINK_MODES);
    if (links > 0)
      out.push(
        line(
          input,
          'wrong_link_shape/dead_link',
          links,
          'above 0',
          'messaging/text-rules.ts:ISSUE_NAV_RE and the link line in assistant/door-persona.ts:assistantOpening',
          'the link line is not landing; state the one URL shape the web opens, /projects/<slug>/issues/<documentId>',
        ),
      );
    const loop = rowsWith(input, LOOP_MODES);
    if (loop > 0)
      out.push(
        line(
          input,
          'over_budget/repeated_call',
          loop,
          'above 0',
          'assistant/run-turn-core.ts:runTurnEvents',
          'the loop lacks a stop; a call already made with the same argv is not made again',
        ),
      );
    const language = rowsWith(input, ['language_mismatch']);
    if (language > 0)
      out.push(
        line(
          input,
          'language_mismatch',
          language,
          'above 0',
          'assistant/door-persona.ts',
          "the persona does not bind the reply language to the question's",
        ),
      );
    const unanswered = rowsWith(input, ['unanswered']);
    if (unanswered > 0)
      out.push(
        line(
          input,
          'unanswered',
          unanswered,
          'above 0',
          'conversations/turn-runner.ts',
          'the door lets a provider error or an empty reply reach the person; retry once or say so',
        ),
      );
  }
  return out;
}

const pct = (count: number, rows: number): string => `${Math.round((count / rows) * 100)}%`;

/** The block for a terminal: `advice:` then one line per finding, or the one line saying none. */
export function adviceLines(lines: readonly AdviceLine[]): string[] {
  if (lines.length === 0) return ['advice: none - every pattern is under its threshold'];
  return [
    'advice:',
    ...lines.map(
      (l) =>
        `  ${l.label}: ${l.pattern} ${l.count}/${l.rows} (${pct(l.count, l.rows)}) ${l.threshold} -> ${l.surface}: ${l.change}`,
    ),
  ];
}

/** One input per task of a run file: rows are turns, the flagged ones with their modes and verdict. */
export function adviceInputsOfRun(result: BenchResult): AdviceInput[] {
  return result.tasks.map((task) => {
    const turns = task.trials.flatMap((t) => t.turns);
    return {
      label: task.id,
      rows: turns.length,
      flagged: turns
        .filter((t) => t.modes.length > 0)
        .map((t) => ({
          modes: t.modes,
          served: t.judge && isVerdict(t.judge) ? t.judge.served : null,
        })),
    };
  });
}

/** One input per model and source group of a history file: its flagged rows, each with its verdict. */
export function adviceInputsOfHistory(result: HistoryResult): AdviceInput[] {
  const verdicts = new Map<string, Served>();
  for (const r of result.judge?.rows ?? [])
    if (isVerdict(r.judge)) verdicts.set(r.chatLogId, r.judge.served);
  return result.groups.map((g) => ({
    label: `${g.model} / ${g.source}`,
    rows: g.rows,
    flagged: result.flagged
      .filter((r) => r.model === g.model && r.source === g.source)
      .map((r) => ({ modes: r.modes, served: verdicts.get(r.chatLogId) ?? null })),
  }));
}
