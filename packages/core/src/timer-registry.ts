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
import { recoverUnstartedReleaseBatches, resumeStrandedFinishes } from './release-batch/index.js';
import { sweepExpiredExecutions, sweepExpiredReportRuns } from './reports/index.js';
import { sweepDeliveredRequirements } from './requirements/index.js';
import { reapGhostRunners, runRunnerStaleSweep } from './runners/index.js';
import type { Timer } from './schedules/index.js';
import { sweepSuggestions } from './suggestions/index.js';

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

export function coreTimers(): Timer[] {
  return [
    // Kernel sweeps.
    { kind: 'cluster', name: 'pipeline-sweeper', cron: '* * * * *', run: runPipelineSweep },
    { kind: 'cluster', name: 'pipeline-reconciler', cron: '* * * * *', run: runReconcilerOnce },
    {
      kind: 'cluster',
      name: 'feedback-auto-verify',
      cron: '*/15 * * * *',
      run: logged(
        'feedback-auto-verify: sweep complete',
        sweepResolvedFeedback,
        (r) => (r as { verified: number }).verified > 0,
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
    // A delivery a linked issue's close could not read (production unreadable then) is raised here.
    {
      kind: 'cluster',
      name: 'requirement-delivery-sweep',
      cron: '*/5 * * * *',
      run: logged(
        'requirement-delivery-sweep: raised',
        sweepDeliveredRequirements,
        (r) => (r as { raised: number }).raised > 0,
      ),
    },

    // Process timers: faster than a minute, or bound to this process's sockets, memory or disk.
    // A preview idles, or fails when its box's tunnel is away: the tunnels are this process's sockets.
    {
      kind: 'process',
      name: 'preview-sweep',
      everyMs: 15_000,
      run: logged('preview-sweep: moved', sweepPreviews, (r) => (r as { moved: number }).moved > 0),
    },
    {
      kind: 'process',
      name: 'web-conversation-drain',
      everyMs: 15_000,
      run: drainWebConversationWindows,
    },
    {
      kind: 'process',
      name: 'rocketchat.window-drain',
      everyMs: 1_500,
      runAtStart: true,
      run: drainRoomWindows,
    },
    {
      kind: 'process',
      name: 'rocketchat.question-drain',
      everyMs: 30_000,
      runAtStart: true,
      run: drainRoomQuestions,
    },
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
