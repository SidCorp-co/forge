// The pipeline sweeper tick: every pass the work and execution kernels, the release domain and
// notifications run once a minute, each isolated so one that throws cannot starve the rest.

import {
  nameOverdueRunnerReleases,
  type RunnerReleaseDeadlineResult,
} from './integrations/github/index.js';
import { type LoopMonitorResult, recordPipelineSweeperTick, runLoopMonitor } from './jobs/index.js';
import { type ReevaluateResult, reevaluateConditions } from './notifications/index.js';
import { logger } from './observability/logger.js';
import { reportFailure } from './observability/sentry.js';
import {
  alarmAgedHolds,
  alarmNeverClaimedDispatches,
  alarmOrphanedJobs,
  alarmPausedRunsWithQueuedWork,
  alarmRejectionStreaks,
  alarmStalledQueuedJobs,
  alarmZombieSessions,
  type ConcludedRunReapResult,
  closeIdleChatSessions,
  detectOrphanedRunAssertions,
  detectOwedCloses,
  detectRetryRescueThresholds,
  detectStrandedIssues,
  type IdleChatCloseResult,
  type IdleIssuesResult,
  type Inv7AlarmResult,
  type IssueRunInvariantResult,
  type IssueRunReapResult,
  type JoblessRunReapResult,
  type OneShotRunReapResult,
  type OrphanedPauseResult,
  type OrphanReconcileResult,
  type RetryRescueAlertResult,
  reapConcludedRuns,
  reapJoblessRuns,
  reapOrphanedIssueRuns,
  reapOrphanedOneShotRuns,
  reapStaleReleaseBatchClaims,
  reconcileIdleIssues,
  recordQueueSnapshots,
  resumeOrphanedPauses,
  type StaleReleaseBatchClaimsResult,
  type StrandedIssuesResult,
  type ZombieSweepResult,
} from './pipeline/index.js';
import { type AutomaticReleaseSweepResult, sweepAutomaticReleases } from './release-batch/index.js';

export interface SweepResult {
  durationMs: number;
  /** ISS-449 — the primary closed-loop pass (reaps). */
  loop: LoopMonitorResult;
  /** Demoted alarm passes (loop-miss counts, no writes). */
  zombieSessions: ZombieSweepResult;
  orphanedJobs: OrphanReconcileResult;
  neverClaimedDispatches: OrphanReconcileResult;
  orphanedOneShotRuns: OneShotRunReapResult;
  /** Chat sessions closed after CHAT_IDLE_CLOSE_MS of quiet (reaps). */
  idleChatSessions: IdleChatCloseResult;
  /** ISS-461 — issue runs closed because their backing issue is terminal (reaps). */
  orphanedIssueRuns: IssueRunReapResult;
  concludedRuns: ConcludedRunReapResult;
  joblessRuns: JoblessRunReapResult;
  /** RFC 0002 INV-7 — holds that outlived their threshold (alarm only). */
  agedHolds: Inv7AlarmResult;
  stalledQueuedJobs: Inv7AlarmResult;
  /** ISS-879 — steps queued behind a run that is paused (alarm only). */
  pausedRunsWithQueuedWork: Inv7AlarmResult;
  /** Runs at or past `noProgressRounds` in CONSECUTIVE review rejections (alarm only). */
  rejectionStreaks: Inv7AlarmResult;
  /** ISS-764 — batch release claims orphaned by a terminal run (claim-subscriber backstop). */
  staleReleaseBatchClaims: StaleReleaseBatchClaimsResult;
  releaseSweep: AutomaticReleaseSweepResult;
  /** ISS-1050 — issues asserting work in progress with no live run behind them (report only). */
  orphanedRunAssertions: IssueRunInvariantResult;
  /** ISS-1122 — non-terminal issues with nothing working them, named on the row itself. */
  idleIssues: IdleIssuesResult;
  /** ISS-762 — issues parked on a decision or a resource, surfaced to project admins. */
  strandedIssues: StrandedIssuesResult;
  owedCloses: StrandedIssuesResult;
  orphanedPauses: OrphanedPauseResult;
  retryRescueThresholds: RetryRescueAlertResult;
  /** ISS-1075 — runner releases past their own deadline, named with what is true on the repository. */
  overdueRunnerReleases: RunnerReleaseDeadlineResult;
  /** ISS-1063 — conditions re-derived: resolved, inhibited children released, stale pending dropped. */
  reevaluated: ReevaluateResult;
  queueSnapshots: number;
}

export async function runPipelineSweep(now: Date = new Date()): Promise<SweepResult> {
  const t0 = Date.now();

  const errors: Array<{ pass: string; err: unknown }> = [];
  const runPass = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (err) {
      errors.push({ pass: name, err });
      logger.error(
        { err, pass: name },
        `pipeline-sweeper: pass '${name}' threw (isolated — remaining passes still run)`,
      );
      reportFailure(err, { tags: { area: 'pipeline-sweeper', sweep_pass: name } });
      return undefined;
    }
  };

  const loop = await runPass('loopMonitor', () => runLoopMonitor(now));
  const zombieSessions = await runPass('alarmZombieSessions', () => alarmZombieSessions(now));
  const orphanedJobs = await runPass('alarmOrphanedJobs', () => alarmOrphanedJobs(now));
  const neverClaimedDispatches = await runPass('alarmNeverClaimedDispatches', () =>
    alarmNeverClaimedDispatches(now),
  );
  const orphanedOneShotRuns = await runPass('reapOrphanedOneShotRuns', () =>
    reapOrphanedOneShotRuns(now),
  );
  const idleChatSessions = await runPass('closeIdleChatSessions', () => closeIdleChatSessions(now));
  const orphanedIssueRuns = await runPass('reapOrphanedIssueRuns', () =>
    reapOrphanedIssueRuns(now),
  );
  const concludedRuns = await runPass('reapConcludedRuns', () => reapConcludedRuns(now));
  const joblessRuns = await runPass('reapJoblessRuns', () => reapJoblessRuns(now));
  const agedHolds = await runPass('alarmAgedHolds', () => alarmAgedHolds(now));
  const stalledQueuedJobs = await runPass('alarmStalledQueuedJobs', () =>
    alarmStalledQueuedJobs(now),
  );
  const pausedRunsWithQueuedWork = await runPass('alarmPausedRunsWithQueuedWork', () =>
    alarmPausedRunsWithQueuedWork(now),
  );
  const orphanedPauses = await runPass('resumeOrphanedPauses', () => resumeOrphanedPauses());
  const rejectionStreaks = await runPass('alarmRejectionStreaks', () => alarmRejectionStreaks());

  const staleReleaseBatchClaims = await runPass('reapStaleReleaseBatchClaims', () =>
    reapStaleReleaseBatchClaims(),
  );
  const releaseSweep = await runPass('releaseSweep', () => sweepAutomaticReleases(now));
  const orphanedRunAssertions = await runPass('detectOrphanedRunAssertions', () =>
    detectOrphanedRunAssertions(now),
  );
  const overdueRunnerReleases = await runPass('nameOverdueRunnerReleases', () =>
    nameOverdueRunnerReleases(now),
  );
  const idleIssues = await runPass('reconcileIdleIssues', () => reconcileIdleIssues(now));
  const strandedIssues = await runPass('detectStrandedIssues', () => detectStrandedIssues(now));
  const owedCloses = await runPass('detectOwedCloses', () => detectOwedCloses(now));
  const retryRescueThresholds = await runPass('detectRetryRescueThresholds', () =>
    detectRetryRescueThresholds(now),
  );
  const reevaluated = await runPass('reevaluateConditions', () => reevaluateConditions(now));
  const queueSnapshots = await runPass('recordQueueSnapshots', () => recordQueueSnapshots());

  // Preserve the ISS-449 missed-tick contract: if ANY pass failed, do NOT
  // record a clean heartbeat — re-throw so `pgboss-health` still sees the
  // missed tick and pg-boss retries the (idempotent) tick. The difference from
  // the old code is purely ordering: every pass has already RUN this tick
  // before we surface the failure, so a single buggy pass can no longer starve
  // the reapers. Each error was logged + captured individually above; re-throw
  // the first so its original cause/message surfaces unchanged.
  if (errors.length > 0) {
    throw errors[0]?.err;
  }

  recordPipelineSweeperTick(t0);
  return {
    durationMs: Date.now() - t0,
    loop: loop as LoopMonitorResult,
    zombieSessions: zombieSessions as ZombieSweepResult,
    orphanedJobs: orphanedJobs as OrphanReconcileResult,
    neverClaimedDispatches: neverClaimedDispatches as OrphanReconcileResult,
    orphanedOneShotRuns: orphanedOneShotRuns as OneShotRunReapResult,
    idleChatSessions: idleChatSessions as IdleChatCloseResult,
    orphanedIssueRuns: orphanedIssueRuns as IssueRunReapResult,
    concludedRuns: concludedRuns as ConcludedRunReapResult,
    joblessRuns: joblessRuns as JoblessRunReapResult,
    agedHolds: agedHolds as Inv7AlarmResult,
    stalledQueuedJobs: stalledQueuedJobs as Inv7AlarmResult,
    pausedRunsWithQueuedWork: pausedRunsWithQueuedWork as Inv7AlarmResult,
    rejectionStreaks: rejectionStreaks as Inv7AlarmResult,
    staleReleaseBatchClaims: staleReleaseBatchClaims as StaleReleaseBatchClaimsResult,
    releaseSweep: releaseSweep as AutomaticReleaseSweepResult,
    orphanedRunAssertions: orphanedRunAssertions as IssueRunInvariantResult,
    idleIssues: idleIssues as IdleIssuesResult,
    strandedIssues: strandedIssues as StrandedIssuesResult,
    owedCloses: owedCloses as StrandedIssuesResult,
    orphanedPauses: orphanedPauses as OrphanedPauseResult,
    retryRescueThresholds: retryRescueThresholds as RetryRescueAlertResult,
    overdueRunnerReleases: overdueRunnerReleases as RunnerReleaseDeadlineResult,
    reevaluated: reevaluated as ReevaluateResult,
    queueSnapshots: queueSnapshots as number,
  };
}
