/**
 * ISS-859 — refuse to record a scheduled run that read nothing as a success.
 *
 * Seven Dream / Skill-Audit runs between 2026-08-13 and 2026-08-17 finished
 * `completed` having called no tool, and then described tool results they
 * never received (session 2e13a106: "Backlog reviewed: 47 non-closed issues",
 * with no tool call in its transcript). The dispatcher had been dead since
 * 08-14; all seven were pointed at it and reported clean.
 *
 * The transcript cannot answer "did it call a tool". `chat.rs`
 * `parse_assistant_message` keeps assistant TEXT and discards every tool
 * frame, so NO agent session stores a tool_use entry — measured 2026-08-26,
 * session 5250d5e1 ran 17 turns over dozens of tool calls and stored zero.
 * The runner's `toolCallCount` is the only evidence, which is why an ABSENT
 * count means "this runner cannot report" and never "blind".
 */

import type { AgentSessionStatus } from '../db/schema.js';

export const BLIND_SCHEDULE_RUN_REASON = 'audit_ran_blind';

const SCHEDULE_SOURCE = 'schedule.run';

export interface BlindScheduleRunInput {
  /** Status after every earlier rewrite in the handler, not the reported one. */
  resolvedStatus: AgentSessionStatus | undefined;
  /** Resolved session metadata — the base the write will persist. */
  metadata: Record<string, unknown> | null | undefined;
  /** `undefined` when the runner did not report; only a real 0 is evidence. */
  toolCallCount: number | undefined;
  /** Hono principal; a member can craft any PATCH body, a device cannot. */
  principal: string | undefined;
}

/**
 * `true` when this terminal report is a scheduled run that demonstrably read
 * no state, and so must persist as `failed` rather than `completed`.
 */
// cm:guard an ABSENT toolCallCount is never blind — every runner released before ISS-859 omits the field, so treating undefined as 0 marks the whole fleet's scheduled runs failed the moment this deploys
// cm:guard device principal only — patchSchema does not validate `messages`, and a project member who could assert toolCallCount:0 could park any schedule at lastStatus 'failed' from a plain PATCH
export function isBlindScheduleRun(input: BlindScheduleRunInput): boolean {
  if (input.principal !== 'device') return false;
  if (input.resolvedStatus !== 'completed') return false;
  if (input.toolCallCount !== 0) return false;
  return input.metadata?.source === SCHEDULE_SOURCE;
}
