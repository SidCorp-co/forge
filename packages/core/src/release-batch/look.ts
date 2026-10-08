// An agent's look at a release batch's live bindings (ISS-1282): the one place a look is checked,
// taken and judged, so the route and the tool answer it alike.
//
// The agent decides WHEN. What this does is take the reading the finish will judge, store it, and
// say at once whether the readings so far would close the roster, so the agent is not left to
// finish in order to find out.

import { abortedError, batchAborted } from './abort-stamp.js';
import { finishVerification, resolveReleaseChannels } from './channel.js';
import {
  ReleaseNothingToReadError,
  ReleaseNotVerifiedError,
  ReleaseRunClosedError,
} from './errors.js';
import { readReleaseRun } from './finish-precondition.js';
import type { Judgement } from './reading-judge.js';
import { judgeRecordedReadings, type ReadingView, takeReading, viewOf } from './readings.js';
import { claimedCommit, notAWholeCommit } from './verify.js';

export interface LookResult {
  reading: ReadingView;
  /** Whether a finish naming the same commit would close the roster on the readings recorded now. */
  judgement:
    | { closable: true; moved: boolean; evidence: string[] }
    | { closable: false; reason: string; live: string | null };
}

export async function lookAtBatch(args: {
  runId: string;
  takenBy: string;
  /** The whole sha the release pushed, to judge the readings against; absent, only that the build moved. */
  commit?: string | undefined;
}): Promise<LookResult> {
  const claim = args.commit === undefined ? null : claimedCommit(args.commit);
  if (args.commit !== undefined && claim === null) {
    throw new ReleaseNotVerifiedError(notAWholeCommit(args.commit, null), null);
  }
  const run = await readReleaseRun(args.runId);
  if (!run) throw new Error(`release batch ${args.runId} not found`);
  if (batchAborted(run)) throw await abortedError(args.runId);
  if (run.status !== 'running' && run.status !== 'paused')
    throw new ReleaseRunClosedError(run.status);

  const verification = finishVerification(await resolveReleaseChannels(run.projectId));
  if (verification.kind === 'unverified') throw new ReleaseNothingToReadError();

  const reading = await takeReading({ runId: args.runId, takenBy: args.takenBy, verification });
  const judged: Judgement = await judgeRecordedReadings({
    runId: args.runId,
    metadata: run.metadata,
    verification,
    claim,
  });
  return {
    reading: viewOf(reading),
    judgement: judged.ok
      ? { closable: true, moved: judged.moved, evidence: judged.evidence }
      : { closable: false, reason: judged.reason, live: judged.live },
  };
}
