/**
 * ISS-859 — refuse to record a scheduled run that read nothing as a success.
 *
 * Seven Dream / Skill-Audit runs between 2026-08-13 and 2026-08-17 finished
 * `completed` having called no tool, and then described tool results they
 * never received (session 2e13a106: "Backlog reviewed: 47 non-closed issues",
 * with no tool call in its transcript). The dispatcher had been dead since
 * 08-14; all seven were pointed at it and reported clean.
 *
 * ISS-1030 — the transcript answers "did it call a tool" now. A chat turn's
 * raw stream-json lines are stored and folded by the one parser, so a session's
 * own `messages` carries every tool call it made. `countTranscriptToolCalls`
 * below reads that, and it is the evidence wherever there is a transcript to
 * read; the runner's reported `toolCallCount` remains the evidence only for a
 * daemon on the previous release, which still counts for itself.
 *
 * What does NOT change is what an absent count means. Every runner released
 * before ISS-859 omits the field, so an absent one is "this runner cannot
 * report" and never "blind" — treating it as 0 would mark the whole fleet's
 * scheduled runs failed the moment it deployed.
 */

import type { AgentSessionStatus } from '../db/schema.js';

export const BLIND_SCHEDULE_RUN_REASON = 'audit_ran_blind';

const SCHEDULE_SOURCE = 'schedule.run';

export interface BlindScheduleRunInput {
  /** Status after every earlier rewrite in the handler, not the reported one. */
  resolvedStatus: AgentSessionStatus | undefined;
  /** Resolved session metadata — the base the write will persist. */
  metadata: Record<string, unknown> | null | undefined;
  /**
   * Tool calls this run made. Read off the stored transcript where the session
   * has one, else the runner's own report. `undefined` when neither can answer;
   * only a real 0 is evidence.
   */
  toolCallCount: number | undefined;
  /** Hono principal; a member can craft any PATCH body, a device cannot. */
  principal: string | undefined;
}

/**
 * `true` when this terminal report is a scheduled run that demonstrably read
 * no state, and so must persist as `failed` rather than `completed`.
 */
// cm:guard an ABSENT toolCallCount is never blind — every runner released before ISS-859 omits the field, so treating undefined as 0 marks the whole fleet's scheduled runs failed the moment this deploys
// cm:guard device principal only — a project member who could assert toolCallCount:0 could park any schedule at lastStatus 'failed' from a plain PATCH
export function isBlindScheduleRun(input: BlindScheduleRunInput): boolean {
  if (input.principal !== 'device') return false;
  if (input.resolvedStatus !== 'completed') return false;
  if (input.toolCallCount !== 0) return false;
  return input.metadata?.source === SCHEDULE_SOURCE;
}

/**
 * How many tool calls this transcript records.
 *
 * cm:guard it counts the ordered `blocks` where a turn has them and falls back
 * to `toolCalls` where it does not, rather than counting both: the derive writes
 * the same call into both fields, so summing them doubles every count and a
 * turn that called one tool would read as two.
 */
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
