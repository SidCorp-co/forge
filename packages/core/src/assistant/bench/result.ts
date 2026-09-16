/**
 * ISS-1051 — the result file holds every fact a reader or a comparison needs after the rooms are
 * gone: each turn's message, delivered text, verdict with evidence, and the attempts behind it;
 * each trial's cleanup with what was expected and what was read back. A file missing a key is
 * refused by name rather than read as an empty run.
 */

import type { CapabilitySummary } from './capability.js';
import type { Evidence, FailureMode } from './grade.js';
import type { JudgeResult } from './judge.js';
import type { Capability } from './task.js';

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

export interface RoomCleanup {
  id: string;
  expected: 'deleted';
  observed: string;
  at: string;
}

export interface CleanupRecord {
  /** Every room the trial opened, in the order opened; a turn marked `room: 'new'` adds one. */
  rooms: RoomCleanup[];
  preferences: {
    expected: { answerStyle: string; assistantInstructions: string | null } | null;
    observed: { answerStyle: string; assistantInstructions: string | null } | null;
    equal: boolean | null;
    at: string | null;
  };
  auditRowsAdded: number;
  /** The memory notes the trial's rooms wrote or that carry a trial token: found, deleted, remaining on read-back; null where no room was opened. */
  memories: { found: number; deleted: number; remaining: number } | null;
}

export interface TrialResult {
  at: string;
  /** Retries the client spent during this trial (one per GET or DELETE whose fetch threw); ISS-1065. */
  retried: number;
  pass: boolean;
  error: string | null;
  seconds: number;
  turns: TurnRecord[];
  cleanup: CleanupRecord;
}

export interface TaskResult {
  id: string;
  capability: Capability;
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
  /** Per capability walked: the same score rule over its tasks (ISS-1061). Derived from `tasks`; a reader recomputes it. */
  capabilities?: CapabilitySummary[];
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
    // cm:why a file written before ISS-1061 names no capability: every task it walked was a method task, and reading it as such keeps an earlier run on the ladder
    if (row.capability === undefined) row.capability = 'method';
    for (const trial of row.trials as Array<Record<string, unknown>>) {
      const cleanup = trial.cleanup as Record<string, unknown> | undefined;
      if (!cleanup) continue;
      // cm:why the same file holds one `cleanup.room`; a trial then opened one room, so it is the one-element list the history verb excludes by
      if (cleanup.rooms === undefined && cleanup.room !== undefined) {
        cleanup.rooms = [cleanup.room];
        delete cleanup.room;
      }
      if (cleanup.memories === undefined) cleanup.memories = null;
    }
    // cm:why a file written before ISS-1065 carries no `retried`: no retry existed, so zero is the truth of that run
    for (const trial of row.trials as Array<Record<string, unknown>>)
      if (trial.retried === undefined) trial.retried = 0;
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
