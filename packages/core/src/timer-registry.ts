// Every timed job core runs for itself, in one list, started by the one scheduler
// (`schedules/timers.ts:startTimers`). A cluster timer keeps the pg-boss queue name it always had.

import { runAlertSweep } from './admin/index.js';
import { retryOwedHandBacks } from './agent-sessions/index.js';
import {
  drainRoomQuestions,
  drainRoomWindows,
  drainWebConversationWindows,
  runTranscriptIndexSweepOnce,
} from './assistant/index.js';
import { runHeartbeatTick } from './conversations/index.js';
import { sweepAgedDecisions } from './development/index.js';
import {
  reapAbandonedDeclarations,
  reapDeadMasterHolds,
  reapDeadRunSessions,
  reapSilentMasters,
  runDevicePrune,
  runDeviceStaleSweep,
} from './devices/index.js';
import { sweepDeclinedFeedback, sweepResolvedFeedback } from './feedback/index.js';
import { refetchRunnerRelease, servesRunnerReleases } from './integrations/github/index.js';
import { runIntegrationsHealthSweep } from './integrations/index.js';
import { releaseHeldJobs, runStaleSweep } from './jobs/index.js';
import { runKnowledgeEmbeddingBackfill } from './knowledge/index.js';
import { logger } from './lib/logger.js';
import { runConsolidationSweep, runEmbeddingBackfill, runMemoryDecay } from './memory/index.js';
import { pruneOutbox } from './outbox/index.js';
import { backfillPhaseJournal, runReconcilerOnce, runRetentionSweep } from './pipeline/index.js';
import { runPipelineSweep } from './pipeline-sweep.js';
import { sweepPreviews } from './previews/index.js';
import { sweepQuestionSuggestions } from './questions/index.js';
import { recoverUnstartedReleaseBatches, resumeStrandedFinishes } from './release-batch/index.js';
import { sweepExpiredExecutions, sweepExpiredReportRuns } from './reports/index.js';
import { reapGhostRunners, runRunnerStaleSweep } from './runners/index.js';
import type { Timer } from './schedules/index.js';
import {
  dispatchStewardRuns,
  type LessonsPassTally,
  runLessonsPass,
  sweepDecisionUpkeep,
  sweepStandings,
} from './steward/index.js';
import { sweepSuggestions } from './suggestions/index.js';
import {
  expireSupportFixes,
  recoverSupportRooms,
  tellAllResults,
  warmColdRooms,
} from './support/index.js';
import { drainWidgetConversationWindows } from './widget/index.js';

/** The memory half of the re-embed sweep, then the knowledge half unless the provider is down. */
async function embeddingBackfillTick(): Promise<void> {
  const t0 = Date.now();
  const memory = await runEmbeddingBackfill();
  const knowledge = memory.aborted
    ? { reembedded: 0, itemsReembedded: 0, aborted: true }
    : await runKnowledgeEmbeddingBackfill();
  const result = {
    reembedded: memory.reembedded,
    knowledgeReembedded: knowledge.reembedded,
    itemsReembedded: knowledge.itemsReembedded,
    aborted: memory.aborted || knowledge.aborted,
    durationMs: Date.now() - t0,
  };
  if (
    result.reembedded > 0 ||
    result.knowledgeReembedded > 0 ||
    result.itemsReembedded > 0 ||
    result.aborted
  ) {
    logger.info(result, 'memory.backfill: sweep complete');
  }
}

/** The nightly retention pass, the suggestions it stales and purges, declined feedback past 180 days, and report runs and executions past their 30-day keep. */
async function retentionTick(): Promise<object> {
  const retention = await runRetentionSweep();
  const suggestions = await sweepSuggestions();
  if (suggestions.staled > 0 || suggestions.purged > 0) {
    logger.info(suggestions, 'retention: suggestions staled and payloads purged');
  }
  const declinedFeedback = await sweepDeclinedFeedback();
  if (declinedFeedback.items > 0) {
    logger.info(
      declinedFeedback,
      'retention: declined feedback attachments and embeddings removed',
    );
  }
  const reportRuns = await sweepExpiredReportRuns();
  if (reportRuns.reportRuns > 0)
    logger.info(reportRuns, 'retention: report runs past their keep deleted');
  const executions = await sweepExpiredExecutions();
  if (executions.reportExecutions > 0)
    logger.info(executions, 'retention: executions past their keep deleted');
  return { ...retention, suggestions, declinedFeedback, ...reportRuns, ...executions };
}

const logged =
  (message: string, run: () => Promise<object>, when: (r: object) => boolean = () => true) =>
  async (): Promise<void> => {
    const result = await run();
    if (when(result)) logger.info(result, message);
  };

/**
 * The question-suggest sweep drafts a recommended answer for an open question. Nothing here moves a
 * requirement or a pin by itself (REQ-41 BC-10, owner ruling 2026-10-14): a design approved past a
 * pin waits on a signer to re-pin it, and a stuck draft is the steward's to ask about (REQ-48 BC-5).
 */
function requirementTimers(): Timer[] {
  return [
    {
      kind: 'cluster',
      name: 'question-suggest-sweep',
      cron: '*/5 * * * *',
      run: logged(
        'question-suggest-sweep: drafted',
        () => sweepQuestionSuggestions(),
        (r) => {
          const { suggested, failed } = r as { suggested: number; failed: number };
          return suggested > 0 || failed > 0;
        },
      ),
    },
  ];
}

/**
 * REQ-48 BC-1: the steward starts a queued run once its debounce passes, within 2 minutes and 30
 * seconds of the trigger, and an item turning stuck by time alone is seen within 5 minutes.
 */
function stewardTimers(): Timer[] {
  return [
    {
      kind: 'cluster',
      name: 'standing-sweep',
      cron: '*/5 * * * *',
      run: logged(
        'standing-sweep: emitted',
        () => sweepStandings(),
        (r) => {
          const { stuck, changed, settledAsks } = r as {
            stuck: number;
            changed: number;
            settledAsks: number;
          };
          return stuck > 0 || changed > 0 || settledAsks > 0;
        },
      ),
    },
    {
      // REQ-68 BC-7, BC-8: a decision whose item moved is voided, an unanswered round is reminded on
      // day 3, and on day 14 the agent proposes deferring or dropping the requirement it holds up
      kind: 'cluster',
      name: 'decision-upkeep',
      cron: '*/5 * * * *',
      run: logged(
        'decision-upkeep: acted',
        () => sweepDecisionUpkeep(),
        (r) => {
          const { voided, reminded, escalated } = r as {
            voided: number;
            reminded: number;
            escalated: number;
          };
          return voided > 0 || reminded > 0 || escalated > 0;
        },
      ),
    },
    {
      // REQ-68 BC-8: a decision that is no question (a sign-off, a release, a design, a proposal) is
      // reminded on day 3 and its decline proposed on day 14, read from each person's Needs you;
      // hourly, as each notice is sent once per decision and person
      kind: 'cluster',
      name: 'decision-ages',
      cron: '17 * * * *',
      run: logged(
        'decision-ages: told',
        () => sweepAgedDecisions(),
        (r) => {
          const { reminded, escalated } = r as { reminded: number; escalated: number };
          return reminded > 0 || escalated > 0;
        },
      ),
    },
    {
      // REQ-50 BC-2, BC-5..BC-7: corrections grouped into proposed lessons, each proposal and
      // confusion settled by the steward, due lessons retired, checks filed (`steward/lessons-pass.ts`)
      kind: 'cluster',
      name: 'lessons-pass',
      cron: '*/10 * * * *',
      run: logged(
        'lessons-pass: ran',
        () => runLessonsPass(),
        (r) => {
          const t = r as LessonsPassTally;
          const moved =
            t.correctionsRejected +
            t.linked +
            t.proposed +
            t.approved +
            t.rejected +
            t.settled +
            t.retired;
          return moved + t.waiting + t.checks + t.failed > 0;
        },
      ),
    },
    {
      kind: 'process',
      name: 'steward-dispatch',
      everyMs: 30_000,
      run: logged(
        'steward-dispatch: ran',
        () => dispatchStewardRuns(new Date(), { wait: false }),
        (r) => {
          const { started, settled } = r as { started: number; settled: number };
          return started > 0 || settled > 0;
        },
      ),
    },
  ];
}

/** Each conversation adapter's drain: what a window its sender's core left behind is still owed. */
function conversationDrains(): Timer[] {
  return [
    {
      kind: 'process',
      name: 'web-conversation-drain',
      everyMs: 15_000,
      run: drainWebConversationWindows,
    },
    {
      kind: 'process',
      name: 'widget-conversation-drain',
      everyMs: 15_000,
      run: drainWidgetConversationWindows,
    },
    {
      kind: 'process',
      name: 'rocketchat.window-drain',
      everyMs: 1_500,
      runAtStart: true,
      run: drainRoomWindows,
    },
    {
      // recovery only: a message goes to its room's session as it is recorded (REQ-75 BC-11); this
      // finds one a crash or a refused write left waiting
      kind: 'process',
      name: 'support.room-drain',
      everyMs: 2_000,
      runAtStart: true,
      run: recoverSupportRooms,
    },
    {
      // a room whose session is not resident on its box is warmed before anyone writes (BC-11)
      kind: 'process',
      name: 'support.room-warm',
      everyMs: 30_000,
      runAtStart: true,
      run: warmColdRooms,
    },
    {
      kind: 'process',
      name: 'support.fix-expiry',
      everyMs: 60_000,
      run: expireSupportFixes,
    },
    {
      // a decline moves a recorded item with no event; read each again (REQ-75 r6 BC-15)
      kind: 'process',
      name: 'support.result-follow',
      everyMs: 60_000,
      run: tellAllResults,
    },
    {
      kind: 'process',
      name: 'rocketchat.question-drain',
      everyMs: 30_000,
      runAtStart: true,
      run: drainRoomQuestions,
    },
  ];
}

export function coreTimers(): Timer[] {
  return [
    // Kernel sweeps.
    { kind: 'cluster', name: 'pipeline-sweeper', cron: '* * * * *', run: runPipelineSweep },
    { kind: 'cluster', name: 'pipeline-reconciler', cron: '* * * * *', run: runReconcilerOnce },
    {
      kind: 'cluster',
      name: 'feedback-loop-check',
      cron: '*/15 * * * *',
      run: logged(
        'feedback-loop-check: sweep complete',
        sweepResolvedFeedback,
        (r) =>
          (r as { verified: number; noted: number }).verified + (r as { noted: number }).noted > 0,
      ),
    },
    {
      kind: 'cluster',
      name: 'phase-journal-backfill',
      cron: '17 * * * *',
      run: logged('phase-journal-backfill: wrote rows', backfillPhaseJournal, (r) => {
        return (r as { rows: number }).rows > 0;
      }),
    },
    {
      kind: 'cluster',
      name: 'job-event-retention',
      cron: '0 3 * * *',
      run: logged('retention: sweep complete', retentionTick),
    },
    {
      kind: 'cluster',
      name: 'outbox-retention',
      cron: '45 3 * * *',
      run: logged('outbox-retention: pruned', pruneOutbox, (r) => {
        const { deliveries, events } = r as { deliveries: number; events: number };
        return deliveries > 0 || events > 0;
      }),
    },
    {
      kind: 'cluster',
      name: 'hold-release',
      cron: '* * * * *',
      run: logged(
        'hold-release: released',
        releaseHeldJobs,
        (r) => (r as { released: number }).released > 0,
      ),
    },
    {
      kind: 'cluster',
      name: 'run-hand-back-retry',
      cron: '* * * * *',
      run: logged('run-hand-back-retry: owed hand-backs repeated', retryOwedHandBacks, (r) => {
        return (r as { owed: number }).owed > 0;
      }),
    },
    {
      kind: 'cluster',
      name: 'stale-job-detector',
      cron: '*/5 * * * *',
      run: logged('stale-job-detector: sweep complete', runStaleSweep),
    },
    {
      kind: 'cluster',
      name: 'master-hold-reaper',
      cron: '* * * * *',
      // Masters first: closing one returns its own holds and its children's leases; the hold
      // sweep then catches a hold whose session row is gone or whose master this pass kept.
      run: async () => {
        const closed = await reapSilentMasters();
        if (closed > 0) logger.info({ closed }, 'master-reaper: sweep closed silent masters');
        const released = await reapDeadMasterHolds();
        if (released > 0)
          logger.info({ released }, 'master-reaper: sweep returned holds to the pool');
      },
    },
    {
      kind: 'cluster',
      name: 'run-session-reaper',
      cron: '* * * * *',
      run: async () => {
        const reaped = await reapDeadRunSessions();
        if (reaped.length > 0) {
          logger.info({ reaped: reaped.length }, 'run-session-reaper: sweep returned runs');
        }
        const abandoned = await reapAbandonedDeclarations();
        if (abandoned > 0) {
          logger.info(
            { abandoned },
            'run-session-reaper: closed declarations the box stopped re-sending',
          );
        }
      },
    },
    {
      kind: 'cluster',
      name: 'device-status-detector',
      cron: '*/2 * * * *',
      run: logged('device-status-detector: sweep complete', runDeviceStaleSweep),
    },
    {
      kind: 'cluster',
      name: 'device-offline-prune',
      cron: '0 4 * * *',
      run: logged('device-offline-prune: sweep complete', runDevicePrune),
    },
    {
      kind: 'cluster',
      name: 'runner-status-detector',
      cron: '* * * * *',
      run: logged('runner-status-detector: sweep complete', runRunnerStaleSweep),
    },
    {
      kind: 'cluster',
      name: 'runner-ghost-reaper',
      cron: '17 * * * *',
      run: logged('ghost-reaper: sweep complete', reapGhostRunners, (r) => {
        return (r as { flagged: number }).flagged > 0;
      }),
    },

    // Domain sweeps.
    {
      kind: 'cluster',
      name: 'release-batch-unstarted-recovery',
      cron: '* * * * *',
      run: recoverUnstartedReleaseBatches,
    },
    {
      kind: 'cluster',
      name: 'release-batch-finish-resume',
      cron: '* * * * *',
      run: () => resumeStrandedFinishes(),
    },
    {
      kind: 'cluster',
      name: 'memory-consolidation',
      cron: '0 3 * * *',
      run: logged('memory.consolidation: sweep complete', runConsolidationSweep),
    },
    {
      kind: 'cluster',
      name: 'memory-decay',
      cron: '30 3 * * *',
      run: logged('memory.decay: sweep complete', runMemoryDecay),
    },
    {
      kind: 'cluster',
      name: 'memory-embedding-backfill',
      cron: '*/5 * * * *',
      run: embeddingBackfillTick,
    },
    {
      kind: 'cluster',
      name: 'conversations.transcript-index',
      cron: '* * * * *',
      run: () => runTranscriptIndexSweepOnce(),
    },
    {
      kind: 'cluster',
      name: 'conversations.heartbeat',
      cron: '* * * * *',
      run: () => runHeartbeatTick(),
    },
    {
      kind: 'cluster',
      name: 'integrations-health-sweep',
      cron: '17 * * * *',
      run: logged('integrations-health-sweep: complete', runIntegrationsHealthSweep),
    },
    { kind: 'cluster', name: 'admin-alert-sweep', cron: '*/5 * * * *', run: () => runAlertSweep() },
    ...requirementTimers(),
    ...stewardTimers(),

    // Process timers: faster than a minute, or bound to this process's sockets, memory or disk.
    // A preview idles, or fails when its box's tunnel is away: the tunnels are this process's sockets.
    {
      kind: 'process',
      name: 'preview-sweep',
      everyMs: 15_000,
      run: logged('preview-sweep: moved', sweepPreviews, (r) => (r as { moved: number }).moved > 0),
    },
    ...conversationDrains(),
    ...(servesRunnerReleases()
      ? [
          {
            kind: 'process',
            name: 'runner-release.refetch',
            everyMs: 30 * 60_000,
            run: refetchRunnerRelease,
          } satisfies Timer,
        ]
      : []),
  ];
}
