// Every timed job core runs for itself, in one list, started by the one scheduler
// (`schedules/timers.ts:startTimers`). A cluster timer keeps the pg-boss queue name it always had.

import { runAlertSweep } from './admin/index.js';
import {
  drainRoomCommentMirror,
  drainRoomQuestions,
  drainWebConversationWindows,
  runAssistantWeeklyOnce,
  runTranscriptIndexSweepOnce,
} from './assistant/index.js';
import { drainRoomWindows, runHeartbeatTick } from './conversations/index.js';
import {
  reapDeadMasterHolds,
  reapDeadRunSessions,
  reapSilentMasters,
  runDevicePrune,
  runDeviceStaleSweep,
} from './devices/index.js';
import { runIntegrationsHealthSweep } from './integrations/index.js';
import {
  refetchRunnerRelease,
  servesRunnerReleases,
} from './integrations/published-releases/index.js';
import { probePgBossBackstop, runStaleSweep } from './jobs/index.js';
import { logger } from './logger.js';
import {
  runChunkBackfill,
  runConsolidationSweep,
  runEmbeddingBackfill,
  runMemoryDecay,
} from './memory/index.js';
import { pruneOutbox } from './outbox/index.js';
import {
  backfillPhaseJournal,
  runPipelineSweep,
  runReconcilerOnce,
  runRetentionSweep,
} from './pipeline/index.js';
import { runPmEscalationSweep, runPmQueuePressureSweepOnce } from './pm/index.js';
import { recoverUnstartedReleaseBatches, resumeStrandedFinishes } from './release-batch/index.js';
import { reapGhostRunners, runRunnerStaleSweep } from './runners/index.js';
import type { Timer } from './schedules/index.js';

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
      run: logged('retention: sweep complete', runRetentionSweep),
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
      name: 'pm.escalation-sweeper',
      cron: '*/5 * * * *',
      run: logged('pm-escalation-sweeper: actioned', runPmEscalationSweep, (r) => {
        const { executed, errors } = r as { executed: number; errors: number };
        return executed > 0 || errors > 0;
      }),
    },
    {
      kind: 'cluster',
      name: 'pm.queue-pressure',
      cron: '* * * * *',
      run: () => runPmQueuePressureSweepOnce(),
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
      run: async () => {
        const result = await runEmbeddingBackfill();
        if (result.reembedded > 0 || result.knowledgeReembedded > 0 || result.aborted) {
          logger.info(result, 'memory.backfill: sweep complete');
        }
        if (result.aborted) return;
        const chunks = await runChunkBackfill();
        if (chunks.chunked > 0 || chunks.aborted) {
          logger.info(chunks, 'memory.backfill: chunk sweep complete');
        }
      },
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
      name: 'assistant-weekly-report',
      cron: '0 4 * * *',
      run: async () => {
        const outcomes = await runAssistantWeeklyOnce();
        const count = (o: string) => outcomes.filter((x) => x.outcome === o).length;
        logger.info(
          { posted: count('posted'), skipped: count('skipped'), failed: count('failed') },
          'assistant.weekly: tick complete',
        );
      },
    },
    {
      kind: 'cluster',
      name: 'integrations-health-sweep',
      cron: '17 * * * *',
      run: logged('integrations-health-sweep: complete', runIntegrationsHealthSweep),
    },
    { kind: 'cluster', name: 'admin-alert-sweep', cron: '*/5 * * * *', run: () => runAlertSweep() },

    // Process timers: faster than a minute, or bound to this process's sockets, memory or disk.
    {
      kind: 'process',
      name: 'pgboss-health',
      everyMs: 30_000,
      run: async () => probePgBossBackstop(),
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
    {
      kind: 'process',
      name: 'rocketchat.comment-mirror',
      everyMs: 30_000,
      runAtStart: true,
      run: drainRoomCommentMirror,
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
