import { logger } from '../logger.js';
import type { HooksBus } from '../pipeline/hooks.js';
import { boss } from '../queue/boss.js';
import { upsertCandidate } from './candidates-accrual.js';
import { extractHandoffGapRescue } from './signals/handoff-gap-rescue.js';
import { extractReopenLoop } from './signals/reopen-loop.js';
import { extractRepeatedFixType } from './signals/repeated-fix-type.js';

export const MEMORY_CANDIDATES_QUEUE = 'memory-candidates';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

interface MinePayload {
  runId: string;
  projectId: string;
  issueId: string;
}

export async function runCandidateMine(payload: MinePayload): Promise<void> {
  const { runId, projectId, issueId } = payload;

  const [signalSets] = await Promise.all([
    Promise.all([
      extractReopenLoop(runId, projectId, issueId),
      extractRepeatedFixType(runId, projectId, issueId),
      extractHandoffGapRescue(runId, projectId, issueId),
    ]),
  ]);

  const signals = signalSets[0].flat();
  logger.info({ runId, projectId, issueId, count: signals.length }, 'candidates-observer: signals extracted');

  for (const signal of signals) {
    await upsertCandidate(projectId, signal);
  }
}

let registered = false;

export function registerCandidatesObserver(bus: HooksBus): void {
  bus.on('pipelineRunStatusChanged', (p) => {
    if (p.kind !== 'issue' || !p.issueId) return;
    if (!TERMINAL_STATUSES.has(p.toStatus)) return;
    // Fire-and-forget: do not block the run-close path.
    void (boss as unknown as { send: (q: string, d: unknown) => Promise<void> })
      .send(MEMORY_CANDIDATES_QUEUE, {
        runId: p.runId,
        projectId: p.projectId,
        issueId: p.issueId,
      })
      .catch((err) => {
        logger.error({ err }, 'candidates-observer: failed to enqueue mine job');
      });
  });
}

export async function registerCandidatesWorker(): Promise<void> {
  if (registered) return;
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).createQueue(MEMORY_CANDIDATES_QUEUE);
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).work(MEMORY_CANDIDATES_QUEUE, async (job: { data: MinePayload }) => {
    try {
      await runCandidateMine(job.data);
    } catch (err) {
      logger.error({ err }, 'candidates-observer: mine job failed');
      throw err;
    }
  });
  registered = true;
}

export function resetCandidatesObserverForTest(): void {
  registered = false;
}
