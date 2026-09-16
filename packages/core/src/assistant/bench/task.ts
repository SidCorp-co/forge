/**
 * ISS-1051 — a benchmark task is data: the turns to send in one room, the checks each reply and
 * its trail must pass, the fixtures the messages read, and the preference the task moves. The
 * check vocabulary is closed so that a test can load every task whole and refuse one it cannot
 * grade, and a grader that cannot fail has not been written.
 */

import type { AnswerStyle } from '../../db/schema.js';

export const CHECK_KINDS = [
  'linkShape',
  'linksResolve',
  'mustMatch',
  'mustNotMatch',
  'language',
  'notFallback',
  'maxSeconds',
  'toolsAllowed',
  'toolsRequired',
  'argvNotMatch',
  'noHelp',
  'noPlaceholder',
  'noRepeatedCall',
  'maxCalls',
  'maxIterations',
  'screenRepair',
  'preferenceRows',
  'inOrder',
  'listInOrder',
  'labeled',
  'linkTo',
  'onlyFrom',
  'maxNotesKept',
] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

/** A `RegExp` is matched as written; a `string` is a literal, with its `{placeholders}` filled first. */
export type Pattern = RegExp | string;

export type PreferenceField = 'answer_style' | 'assistant_instructions';

/** One `preference_changes` row a turn is expected to leave; a value left out is not checked. */
export interface ExpectedRow {
  field: PreferenceField;
  newValue?: string;
  previousValue?: string;
}

export type Check =
  | { kind: 'linkShape' }
  | { kind: 'linksResolve' }
  | { kind: 'mustMatch'; patterns: Pattern[] }
  | { kind: 'mustNotMatch'; patterns: Pattern[] }
  /** A diacritic heuristic, not a language verdict: see `grade.ts:vietnameseWords`. */
  | { kind: 'language'; diacritics: 'vi' | 'en' }
  | { kind: 'notFallback' }
  | { kind: 'maxSeconds' }
  | { kind: 'toolsAllowed'; tools: string[] }
  | { kind: 'toolsRequired'; tools: string[] }
  | { kind: 'argvNotMatch'; pattern: RegExp }
  | { kind: 'noHelp' }
  | { kind: 'noPlaceholder' }
  | { kind: 'noRepeatedCall' }
  | { kind: 'maxCalls'; max: number }
  | { kind: 'maxIterations'; max: number }
  | { kind: 'screenRepair' }
  | { kind: 'preferenceRows'; rows: ExpectedRow[] }
  /** Every pattern matches, and each first match lies after the one before it. */
  | { kind: 'inOrder'; patterns: Pattern[] }
  /** Every member of a `, `-joined fixture list matches, in the list's order (codex F1 on ISS-1061). */
  | { kind: 'listInOrder'; list: string }
  /** The filled value stands as a whole number in the same clause as the label, nearest to it, in either order (codex F2). */
  | { kind: 'labeled'; label: RegExp; value: string }
  /** Some issue link in the reply targets the filled issue id (codex F3). */
  | { kind: 'linkTo'; issueId: string }
  /** The reply names no pipeline state outside the `, `-joined fixture list (ISS-1065). */
  | { kind: 'onlyFrom'; list: string }
  /** The trial kept at most `max` memory notes, read from the cleanup's count (ISS-1064). */
  | { kind: 'maxNotesKept'; max: number };

/** What a fixture reads from the deployment before the first turn, and the placeholders it fills. */
export type FixtureName =
  | 'firstOpenIssue'
  | 'newestOpenIssues'
  | 'projectName'
  | 'issueCounts'
  | 'waitingIssue'
  | 'pipelineStates'
  | 'nonce';
export const FIXTURE_KEYS: Record<FixtureName, readonly string[]> = {
  firstOpenIssue: ['issueKey', 'issueId'],
  /** The newest open issues, bounded: on a project holding 682 a task asking for every one measures patience rather than linking (ISS-1066). */
  newestOpenIssues: ['openIssueKeys', 'openIssueCount', 'openIssueId'],
  projectName: ['projectName'],
  /** The project's issues counted by status, read before the turn so the answer is the project's own. */
  issueCounts: ['openCount', 'closedCount', 'draftCount'],
  /** The first issue waiting on information; its own fixture, so a project with none still runs the counts (codex F4). */
  waitingIssue: ['needsInfoKey', 'needsInfoId'],
  /** The project's EFFECTIVE pipeline states in order, joined by `, ` — the canonical ladder with this project's stage overrides applied, never the stored config's keys (ISS-1066). */
  pipelineStates: ['stateList'],
  /** Two independent random tokens per trial, so a correction task refuses the first by literal (codex F2). */
  nonce: ['nonce', 'nonce2'],
};

/** What a task measures; the report groups its figures by this and never guesses it. */
export const CAPABILITIES = [
  'method',
  'project-understanding',
  'memory-storing',
  'long-context',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface Turn {
  message: string;
  checks: Check[];
  /** This turn and the ones after it go to a fresh room; refused on a task's first turn. */
  room?: 'new';
}

export interface TaskPreference {
  /** Written before the first turn, so a turn can be graded against a known style. */
  setup?: { answerStyle: AnswerStyle };
  /** The only restore there is: the value read before the trial is written back after it. */
  restore: 'baseline';
}

export interface Task {
  id: string;
  capability: Capability;
  /** One plain-English sentence: what the person wants from the turn(s). `harvest.ts` reads it for coverage. */
  intent: string;
  /** One sentence the judge reads beside the generic rule: what "served" means for this task. */
  judgeRubric?: string;
  budgetSeconds: number;
  fixtures?: FixtureName[];
  preference?: TaskPreference;
  turns: Turn[];
}

export class TaskLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskLoadError';
  }
}

const PLACEHOLDER_RE = /\{(\w+)\}/g;

function placeholdersIn(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER_RE)].map((m) => m[1] ?? '');
}

/** Every literal a check carries, so a placeholder no fixture fills is refused at load. */
function literalPatterns(check: Check): string[] {
  if (check.kind === 'listInOrder') return [check.list];
  if (check.kind === 'labeled') return [check.value];
  if (check.kind === 'linkTo') return [check.issueId];
  if (check.kind === 'onlyFrom') return [check.list];
  if (check.kind !== 'mustMatch' && check.kind !== 'mustNotMatch' && check.kind !== 'inOrder')
    return [];
  return check.patterns.filter((p): p is string => typeof p === 'string');
}

function movesPreferences(task: Task): boolean {
  return (
    task.preference?.setup !== undefined ||
    task.turns.some((t) => t.checks.some((c) => c.kind === 'preferenceRows'))
  );
}

/** What a multi-turn rubric has to say so the judge knows which turn a requirement is about. */
const TURN_SCOPED = /\bon (a|the|each|every|its) (\w+ )?turn\b/i;

/** Refuse the task list by name where it cannot be graded whole, else return it as given. */
export function validateTasks(list: readonly Task[]): Task[] {
  const seen = new Set<string>();
  const kinds = new Set<string>(CHECK_KINDS);
  for (const task of list) {
    if (seen.has(task.id)) throw new TaskLoadError(`task id ${task.id} appears twice`);
    seen.add(task.id);
    if (!task.intent?.trim()) throw new TaskLoadError(`task ${task.id} carries no intent line`);
    if (!(CAPABILITIES as readonly string[]).includes(task.capability))
      throw new TaskLoadError(
        `task ${task.id} names capability ${String(task.capability)}, not one of ${CAPABILITIES.join(', ')}`,
      );
    if (
      task.judgeRubric !== undefined &&
      (/\n/.test(task.judgeRubric) || task.judgeRubric.length > 300)
    )
      throw new TaskLoadError(`task ${task.id} judgeRubric must be one line under 300 characters`);
    // cm:guard `run.ts#judgeTurns` hands the rubric to EVERY judged turn of the task, so a
    // task-wide requirement on a multi-turn task is one the person never asked for on the early
    // turns: "served means the reply gives the deploy window" failed the turn that had only asked
    // the assistant to remember it, and the disagreement read as the assistant's (ISS-1066).
    if (
      task.judgeRubric !== undefined &&
      task.turns.length > 1 &&
      !TURN_SCOPED.test(task.judgeRubric)
    )
      throw new TaskLoadError(
        `task ${task.id} judgeRubric is handed to every one of its ${task.turns.length} turns, so it must name the turn each requirement belongs to ("on the first turn…", "on a turn that…", "on each turn…")`,
      );
    if (!(task.budgetSeconds > 0))
      throw new TaskLoadError(`task ${task.id} names no budget in seconds`);
    if (task.turns.length === 0) throw new TaskLoadError(`task ${task.id} has no turn`);
    const filled = new Set((task.fixtures ?? []).flatMap((f) => FIXTURE_KEYS[f]));
    task.turns.forEach((turn, index) => {
      const where = `task ${task.id} turn ${index + 1}`;
      if (turn.checks.length === 0) throw new TaskLoadError(`${where} carries no check`);
      if (index === 0 && turn.room === 'new')
        throw new TaskLoadError(`${where} asks for a new room, and the first turn opens the room`);
      for (const check of turn.checks) {
        if (!kinds.has(check.kind))
          throw new TaskLoadError(
            `${where} names check kind ${String(check.kind)}, not in the vocabulary`,
          );
      }
      const texts = [turn.message, ...turn.checks.flatMap(literalPatterns)];
      for (const key of texts.flatMap(placeholdersIn)) {
        if (!filled.has(key))
          throw new TaskLoadError(`${where} reads {${key}}, which no fixture of the task fills`);
      }
    });
    if (movesPreferences(task) && task.preference?.restore !== 'baseline')
      throw new TaskLoadError(`task ${task.id} moves a preference and names no restore`);
  }
  return [...list];
}

/** Fill `{placeholders}` from the fixtures read; a key left unfilled is a loader defect, so it throws. */
export function fill(text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER_RE, (_, key: string) => {
    const value = values[key];
    if (value === undefined) throw new TaskLoadError(`placeholder {${key}} has no value`);
    return value;
  });
}
