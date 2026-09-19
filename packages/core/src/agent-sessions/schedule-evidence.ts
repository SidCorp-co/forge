import type { AgentSessionStatus } from '../db/schema.js';

export const BLIND_SCHEDULE_RUN_REASON = 'audit_ran_blind';

const SCHEDULE_SOURCE = 'schedule.run';

export interface BlindScheduleRunInput {
  /** Status after every earlier rewrite in the handler, not the reported one. */
  resolvedStatus: AgentSessionStatus | undefined;
  /** Resolved session metadata — the base the write will persist. */
  metadata: Record<string, unknown> | null | undefined;
  toolCallCount: number | undefined;
  /** Hono principal; a member can craft any PATCH body, a device cannot. */
  principal: string | undefined;
}

export function isBlindScheduleRun(input: BlindScheduleRunInput): boolean {
  if (input.principal !== 'device') return false;
  if (input.resolvedStatus !== 'completed') return false;
  if (input.toolCallCount !== 0) return false;
  return input.metadata?.source === SCHEDULE_SOURCE;
}

export function countTranscriptToolCalls(messages: unknown): number | undefined {
  if (!Array.isArray(messages)) return undefined;
  let n = 0;
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as { blocks?: unknown; toolCalls?: unknown };
    if (Array.isArray(entry.blocks)) {
      n += entry.blocks.filter((b) => (b as { type?: unknown } | null)?.type === 'tool').length;
      continue;
    }
    if (Array.isArray(entry.toolCalls)) n += entry.toolCalls.length;
  }
  return n;
}
