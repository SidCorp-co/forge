// What one lessons pass on one project leaves on the capabilities read (ISS-1251 round 6): the step
// it reached, the step it stopped at with its error, and each judge that gave no answer with the last
// reason its model call gave. From 2026-11-17 12:10Z forge-dev's pass failed at its first step every
// ten minutes and a judge's empty answer was a warn line: neither reached anything a master or a
// judge could read, so nothing moved for hours and nobody could say why.

import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  LessonsPassJudge,
  LessonsPassReport,
  LessonsPassStep,
} from '@forge/contracts/capabilities';
import { keepLessonsPassReport } from '../lessons/index.js';
import { logger } from '../lib/logger.js';

const ERROR_CHARS = 2000;

/** One project's pass as it goes: the step it is at, and each judge's empty answers. */
export class PassRecord {
  readonly startedAt = new Date();
  step: LessonsPassStep = 'gather';
  private miss: { miss: string; detail: string } | null = null;
  private readonly unanswered = new Map<
    LessonsPassJudge,
    { count: number; miss: string | null; detail: string | null }
  >();

  at(step: LessonsPassStep): void {
    this.step = step;
  }

  /** What the model call a judge just made gave instead of an answer. */
  missed(miss: string, detail: string): void {
    this.miss = { miss, detail: detail.slice(0, ERROR_CHARS) };
  }

  /** A judge gave no answer: counted, with the reason its model call said, where it said one. */
  noAnswer(judge: LessonsPassJudge): void {
    const was = this.unanswered.get(judge) ?? { count: 0, miss: null, detail: null };
    this.unanswered.set(judge, {
      count: was.count + 1,
      miss: this.miss?.miss ?? was.miss,
      detail: this.miss?.detail ?? was.detail,
    });
    this.miss = null;
  }

  /** The report this pass leaves; `failed` is what stopped it, if anything did. */
  report(tally: Record<string, number>, failed?: unknown): LessonsPassReport {
    return {
      startedAt: this.startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      stopped: failed === undefined ? null : { step: this.step, error: errorLine(failed) },
      tally,
      unanswered: [...this.unanswered].map(([judge, u]) => ({ judge, ...u })),
    };
  }
}

/** An error as one line a reader can act on: the innermost cause, where a query wrapped it. */
export function errorLine(err: unknown): string {
  let at: unknown = err;
  while (at instanceof Error && at.cause instanceof Error) at = at.cause;
  const text = at instanceof Error ? at.message : String(at);
  return text.slice(0, ERROR_CHARS) || 'an error with no message';
}

const current = new AsyncLocalStorage<PassRecord>();

/** Run one project's pass with `record` as the one its judges report to. */
export const recording = <T>(record: PassRecord, run: () => Promise<T>): Promise<T> =>
  current.run(record, run);

/**
 * A model judge's call gave no answer: why (`unconfigured`, `withheld`, `failed`, `unreadable`) and
 * its detail, kept on the pass that asked so the read names it beside the judge.
 */
export function noteJudgeMiss(miss: string, detail: string): void {
  current.getStore()?.missed(miss, detail);
}

type Judge = (...args: never[]) => Promise<unknown>;

/** Each judge, its empty answers counted on `record` under its name; what it answers is unchanged. */
export function reportingJudges<J extends Record<LessonsPassJudge, Judge>>(
  judges: J,
  record: PassRecord,
): J {
  const out = {} as Record<LessonsPassJudge, Judge>;
  for (const name of Object.keys(judges) as LessonsPassJudge[]) {
    const judge = judges[name];
    out[name] = async (...args: never[]) => {
      const answer = await judge(...args);
      if (answer === null || answer === undefined) record.noAnswer(name);
      return answer;
    };
  }
  return out as J;
}

/** Keep the pass's report; a report that cannot be kept is said, never the pass's own failure. */
export async function keepReport(projectId: string, report: LessonsPassReport): Promise<void> {
  try {
    await keepLessonsPassReport(projectId, report);
  } catch (err) {
    logger.error({ err, projectId }, 'steward: a lessons pass report could not be kept');
  }
}
