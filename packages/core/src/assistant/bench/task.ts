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
  | { kind: 'preferenceRows'; rows: ExpectedRow[] };

/** What a fixture reads from the deployment before the first turn, and the placeholders it fills. */
export type FixtureName = 'firstOpenIssue' | 'projectName';
export const FIXTURE_KEYS: Record<FixtureName, readonly string[]> = {
  firstOpenIssue: ['issueKey', 'issueId'],
  projectName: ['projectName'],
};

export interface Turn {
  message: string;
  checks: Check[];
}

export interface TaskPreference {
  /** Written before the first turn, so a turn can be graded against a known style. */
  setup?: { answerStyle: AnswerStyle };
  /** The only restore there is: the value read before the trial is written back after it. */
  restore: 'baseline';
}

export interface Task {
  id: string;
  /** One plain-English sentence: what the person wants from the turn(s). `harvest.ts` reads it for coverage. */
  intent: string;
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

function literalPatterns(check: Check): string[] {
  if (check.kind !== 'mustMatch' && check.kind !== 'mustNotMatch') return [];
  return check.patterns.filter((p): p is string => typeof p === 'string');
}

function movesPreferences(task: Task): boolean {
  return (
    task.preference?.setup !== undefined ||
    task.turns.some((t) => t.checks.some((c) => c.kind === 'preferenceRows'))
  );
}

/** Refuse the task list by name where it cannot be graded whole, else return it as given. */
export function validateTasks(list: readonly Task[]): Task[] {
  const seen = new Set<string>();
  const kinds = new Set<string>(CHECK_KINDS);
  for (const task of list) {
    if (seen.has(task.id)) throw new TaskLoadError(`task id ${task.id} appears twice`);
    seen.add(task.id);
    if (!task.intent?.trim()) throw new TaskLoadError(`task ${task.id} carries no intent line`);
    if (!(task.budgetSeconds > 0))
      throw new TaskLoadError(`task ${task.id} names no budget in seconds`);
    if (task.turns.length === 0) throw new TaskLoadError(`task ${task.id} has no turn`);
    const filled = new Set((task.fixtures ?? []).flatMap((f) => FIXTURE_KEYS[f]));
    task.turns.forEach((turn, index) => {
      const where = `task ${task.id} turn ${index + 1}`;
      if (turn.checks.length === 0) throw new TaskLoadError(`${where} carries no check`);
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
