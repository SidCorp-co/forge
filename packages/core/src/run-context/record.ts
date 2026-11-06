// The recorder: each source that reached a run is written beside the read or the composition that
// gave it, off that path. A write is started as background work (`lib/background.ts`), so the read
// answers whether or not it lands; a write that fails, or a box credential's read no single run can
// be named for, is logged and counted here, and the read route answers both counts, so a gap in the
// record is said rather than read as "nothing reached it".

import type { RunContextHow, RunContextSource } from '@forge/contracts/run-context';
import { db } from '../db/client.js';
import { withoutQueryTiming } from '../db/query-timing.js';
import { runContextReaches } from '../db/schema-run-context.js';
import { background } from '../lib/background.js';
import { reportFailure } from '../lib/error-tracking.js';
import { logger } from '../lib/logger.js';
import { type RunCaller, runContextPort } from './ports.js';

/** The run a source reached, and the issues it works. */
export interface RunSubject {
  projectId: string;
  sessionId: string;
  /** The issues the run works; empty for a session working none. */
  issueIds: readonly string[];
}

const writes = background();

/** Starts `job` off the request's path and out of its `Server-Timing`; a throw goes to `onError`. */
const work = {
  start: (job: () => Promise<void>, onError: (err: unknown) => void) =>
    writes.start(() => withoutQueryTiming(job), onError),
  settled: () => writes.settled(),
};

const tally = { failed: 0, unattributed: 0, since: new Date().toISOString() };

/** How many reaches this process could not record since it started, by why. */
export function runContextTally(): { failed: number; unattributed: number; since: string } {
  return { ...tally };
}

/** Settles every write the recorder started, for a caller that must read after them. */
export const runContextSettled = (): Promise<void> => work.settled();

/** One batch insert: a row per source, and per issue where the run works several. */
async function write(
  subject: RunSubject,
  how: RunContextHow,
  sources: readonly RunContextSource[],
): Promise<void> {
  const issues = subject.issueIds.length > 0 ? subject.issueIds : [null];
  const rows = issues.flatMap((issueId) =>
    sources.map((s) => ({
      projectId: subject.projectId,
      agentSessionId: subject.sessionId,
      issueId,
      kind: s.kind,
      ref: s.ref,
      revision: s.revision,
      how,
    })),
  );
  await db.insert(runContextReaches).values(rows);
}

/** Counts, logs and reports one reach that could not be recorded; the caller goes on. */
export function failed(context: Record<string, unknown>) {
  return (err: unknown) => {
    tally.failed += 1;
    logger.error(
      { err, ...context, runContextFailures: tally.failed },
      'run-context: what reached a run could not be recorded; the read it records answered anyway',
    );
    reportFailure(err, { tags: { source: 'run-context' }, extra: context });
  };
}

/**
 * Records `sources` as composed into a run's prompt or orientation. Never throws and never waits:
 * a failed write is logged and counted.
 */
export function recordCarried(subject: RunSubject, sources: readonly RunContextSource[]): void {
  if (sources.length === 0) return;
  work.start(
    () => write(subject, 'prompt', sources),
    failed({ projectId: subject.projectId, sessionId: subject.sessionId, how: 'prompt' }),
  );
}

/**
 * Records what `compose` reads a run was given, where reading it is itself work kept off the caller's
 * path (a declared run's orientation). Never throws and never waits; a failed read is counted as a
 * failed write.
 */
export function recordCarriedLater(
  run: { projectId: string; sessionId: string },
  compose: () => Promise<{ issueIds: readonly string[]; sources: readonly RunContextSource[] }>,
): void {
  work.start(
    async () => {
      const { issueIds, sources } = await compose();
      if (sources.length > 0) await write({ ...run, issueIds }, 'prompt', sources);
    },
    failed({ projectId: run.projectId, sessionId: run.sessionId, how: 'prompt' }),
  );
}

/**
 * Records what a box credential's read returned against the run it was made in. A read no single
 * run can be named for is counted as unattributed and written nowhere. Never throws and never waits.
 */
export function recordCalled(
  caller: RunCaller,
  how: Exclude<RunContextHow, 'prompt'>,
  sources: readonly RunContextSource[],
): void {
  if (sources.length === 0) return;
  const context = { projectId: caller.projectId, deviceId: caller.deviceId, how };
  work.start(async () => {
    const run = await runContextPort('runOfCall')(caller);
    if (!run.ok) {
      tally.unattributed += 1;
      logger.info(
        { ...context, asked: caller.asked, reason: run.reason, unattributed: tally.unattributed },
        'run-context: a box credential read sources and no single run could be named, so they are not recorded',
      );
      return;
    }
    await write(
      { projectId: caller.projectId, sessionId: run.sessionId, issueIds: run.issueIds },
      how,
      sources,
    );
  }, failed(context));
}
