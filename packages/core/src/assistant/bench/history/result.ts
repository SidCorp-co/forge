/**
 * ISS-1053 - the history file: the window, the deployment it was read from, the budgets the grades
 * were taken at, what was excluded, and the summary. A file missing a key is refused by name.
 */

import type { FailureMode } from '../grade.js';
import type { Agreement, JudgeResult, Tally } from '../judge.js';
import type { Summary } from './summarize.js';

export interface JudgedRow {
  chatLogId: string;
  sessionId: string | null;
  createdAt: string;
  model: string;
  source: string;
  modes: FailureMode[];
  judge: JudgeResult;
  /** The person's query as the judge read it; absent on a file judged before ISS-1055. */
  query?: string;
  /** The row's `user_key`, the name the door knew the asker by; null where it had none. */
  askedBy?: string | null;
}

export interface JudgeGroup {
  model: string;
  source: string;
  tally: Tally;
}

/** What the sidecar judge said about the sample; never read into a mode or a rate. */
export interface HistoryJudge {
  model: string;
  /** The `--judge-sample` asked for; `rows.length` is what the window had to give. */
  sample: number;
  rows: JudgedRow[];
  groups: JudgeGroup[];
  agreement: Agreement;
}

export interface HistoryResult extends Summary {
  at: string;
  api: string;
  commit: string | null;
  version: string;
  window: { projectSlug: string; from: string; to: string; source: string | null };
  budgetSeconds: number;
  maxIterations: number;
  /** Whether UUID links were looked up (`--resolve`). */
  resolved: boolean;
  excludedSessions: string[];
  /** Sessions dropped because a row of theirs sent a shipped task's message (ISS-1065 D2), apart from the run-file ones. */
  excludedSessionsByTask: string[];
  excludedRowsByTask: number;
  judge?: HistoryJudge;
}

const KEYS = [
  'at',
  'api',
  'commit',
  'version',
  'window',
  'budgetSeconds',
  'maxIterations',
  'resolved',
  'excludedSessions',
  'excludedRows',
  'groups',
  'flagged',
] as const;

export class HistoryShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HistoryShapeError';
  }
}

export function readHistoryResult(text: string, where = 'history'): HistoryResult {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new HistoryShapeError(`${where} is not an object`);
  const obj = parsed as Record<string, unknown>;
  for (const key of KEYS) {
    if (!(key in obj)) throw new HistoryShapeError(`${where} lacks ${key}`);
  }
  if (obj.excludedSessionsByTask === undefined) obj.excludedSessionsByTask = [];
  if (obj.excludedRowsByTask === undefined) obj.excludedRowsByTask = 0;
  if (!Array.isArray(obj.groups) || !Array.isArray(obj.flagged))
    throw new HistoryShapeError(`${where}.groups and .flagged must be lists`);
  return obj as unknown as HistoryResult;
}

export const serializeHistory = (result: HistoryResult): string =>
  `${JSON.stringify(result, null, 2)}\n`;
