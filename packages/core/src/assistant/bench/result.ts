/**
 * ISS-1051 — the result file holds every fact a reader or a comparison needs after the rooms are
 * gone: each turn's message, delivered text, verdict with evidence, and the attempts behind it;
 * each trial's cleanup with what was expected and what was read back. A file missing a key is
 * refused by name rather than read as an empty run.
 */

import type { Evidence, FailureMode } from './grade.js';
import type { JudgeResult } from './judge.js';

export interface AttemptRecord {
  chatLogId: string;
  calls: number;
  iterations: number;
  ms: number;
  reply: string | null;
  error: string | null;
}

export interface TurnRecord {
  index: number;
  message: string;
  reply: string | null;
  pass: boolean;
  modes: FailureMode[];
  evidence: Evidence[];
  seconds: number;
  attempts: AttemptRecord[];
  /** The sidecar judge's verdict, or its error; absent when the run had no judge. Never read into `pass`. */
  judge?: JudgeResult;
}

export interface CleanupRecord {
  room: { id: string; expected: 'deleted'; observed: string; at: string };
  preferences: {
    expected: { answerStyle: string; assistantInstructions: string | null } | null;
    observed: { answerStyle: string; assistantInstructions: string | null } | null;
    equal: boolean | null;
    at: string | null;
  };
  auditRowsAdded: number;
}

export interface TrialResult {
  at: string;
  pass: boolean;
  error: string | null;
  seconds: number;
  turns: TurnRecord[];
  cleanup: CleanupRecord;
}

export interface TaskResult {
  id: string;
  trials: TrialResult[];
}

export interface BenchResult {
  at: string;
  api: string;
  commit: string | null;
  version: string;
  model: string | null;
  runId: string;
  k: number;
  tasks: TaskResult[];
  /** The judge model, when the run had one. */
  judge?: { model: string };
}

const RESULT_KEYS = ['at', 'api', 'commit', 'version', 'model', 'runId', 'k', 'tasks'] as const;
const TRIAL_KEYS = ['at', 'pass', 'error', 'seconds', 'turns', 'cleanup'] as const;

export class ResultShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResultShapeError';
  }
}

/** Parse a result file, refusing one whose shape is not the one `writeResult` produced. */
export function readResult(text: string, where = 'result'): BenchResult {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new ResultShapeError(`${where} is not an object`);
  const obj = parsed as Record<string, unknown>;
  for (const key of RESULT_KEYS) {
    if (!(key in obj)) throw new ResultShapeError(`${where} lacks ${key}`);
  }
  if (!Array.isArray(obj.tasks)) throw new ResultShapeError(`${where}.tasks is not a list`);
  obj.tasks.forEach((task: unknown, t) => {
    const row = task as Record<string, unknown>;
    if (typeof row.id !== 'string' || !Array.isArray(row.trials))
      throw new ResultShapeError(`${where}.tasks[${t}] lacks id or trials`);
    row.trials.forEach((trial: unknown, i) => {
      for (const key of TRIAL_KEYS) {
        if (!(key in (trial as Record<string, unknown>)))
          throw new ResultShapeError(`${where}.tasks[${t}].trials[${i}] lacks ${key}`);
      }
    });
  });
  return obj as unknown as BenchResult;
}

export const serializeResult = (result: BenchResult): string =>
  `${JSON.stringify(result, null, 2)}\n`;
