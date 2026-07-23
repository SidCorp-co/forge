import { logger } from '../logger.js';
import { extractPromptString } from './turns-helpers.js';

/**
 * ISS-572 — build a failure-text blob from a session's transcript + the
 * runner's terminal `note`, so a usage/session-limit RESULT_ERROR that the
 * runner streamed into the messages (e.g. `[RESULT_ERROR] success: You've hit
 * your weekly limit · resets 11am (Asia/Ho_Chi_Minh)`) can be classified.
 * Scans only the tail (limits surface in the terminal system/assistant
 * message) and caps length so a long transcript stays cheap.
 */
export function extractSessionFailureText(
  messages: unknown,
  note: string | null | undefined,
): string {
  const parts: string[] = [];
  if (typeof note === 'string' && note.trim()) parts.push(note);
  if (Array.isArray(messages)) {
    for (const m of messages.slice(-6)) {
      if (m && typeof m === 'object') {
        const content = (m as { content?: unknown }).content;
        const text = extractPromptString(content);
        if (text) parts.push(text);
      }
    }
  }
  const blob = parts.join('\n');
  return blob.length > 4000 ? blob.slice(-4000) : blob;
}

/**
 * ISS-733 fix — detect the "unexpanded skill slash-command" failure signature
 * on a chat-runs-skill cold start (turn 1 = `/${skillName}`, see chat-turn.ts
 * `pendingSkillName`). The sync-then-dispatch race: `requestSkillSync` is
 * fire-and-forget, so the skill file can land on the runner's disk AFTER
 * `agent:start` fires. The CLI then short-circuits `/<skillName>` as an
 * unrecognized command (`Unknown command: /<skillName>`), produces zero
 * turns, but still reports `is_error=false` — the exact zero-turn no-op
 * `claude_code.rs` / `stage-stall-guard.ts` already guard for pipeline JOBS
 * (`is_issue_job` only); chat has no runner-side equivalent, so without this
 * check the session silently reports `completed`.
 *
 * Scoped to the assistant messages appended AFTER `priorMessageCount` (the
 * session's message count before this turn) so a later, unrelated turn that
 * happens to mention the phrase in prose can never match.
 */
export function detectUnexpandedSkillFailure(
  messages: unknown,
  skillName: string,
  priorMessageCount: number,
): boolean {
  if (!Array.isArray(messages)) return false;
  const escapedSkillName = skillName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`unknown command:\\s*/${escapedSkillName}\\b`, 'i');
  for (const m of messages.slice(priorMessageCount)) {
    if (m && typeof m === 'object') {
      const shape = m as { role?: unknown; type?: unknown; content?: unknown };
      const kind = shape.role ?? shape.type;
      if (kind === 'assistant') {
        const text = extractPromptString(shape.content);
        if (pattern.test(text)) return true;
      }
    }
  }
  return false;
}

/**
 * ISS-572 — detect a usage/session-limit failure from a session's transcript +
 * the runner's terminal note. Returns `{ hit, resetAt }`. Pure detection reused
 * by both terminal-report paths (the runner's chat/schedule failure PATCHes
 * `/:id` via patch_session; some runs report `/desktop/status`).
 */
export async function detectUsageLimitFromSession(
  messages: unknown,
  note: string | null | undefined,
): Promise<{ hit: boolean; resetAt: string | null }> {
  const { isUsageLimitError, parseUsageLimitReset } = await import('../runners/limit-detect.js');
  const text = extractSessionFailureText(messages, note);
  if (!isUsageLimitError(text)) return { hit: false, resetAt: null };
  const reset = parseUsageLimitReset(text);
  return { hit: true, resetAt: reset ? reset.toISOString() : null };
}

/**
 * ISS-572 — recover a rate-limited SCHEDULE run by failing over to a device
 * whose account has headroom (reuses the loop-monitor failover). No headroom
 * device → the schedule's next cron tick recovers once the window resets.
 * Best-effort — never throws (a recovery failure must not break the status
 * write that already persisted the classified reason).
 */
export async function recoverScheduleOnUsageLimit(
  sessionId: string,
  metadata: unknown,
  resetAt: string | null,
): Promise<void> {
  const meta = (metadata ?? {}) as Record<string, unknown>;
  if (meta.source !== 'schedule.run') return;
  try {
    const { redispatchScheduleSessionOnFailover } = await import('../schedules/dispatch.js');
    const result = await redispatchScheduleSessionOnFailover(sessionId);
    logger.info(
      { sessionId, scheduleId: meta.scheduleId, resetAt, result },
      'agent-sessions: schedule usage-limit → cross-account failover',
    );
  } catch (err) {
    logger.error(
      { err, sessionId, scheduleId: meta.scheduleId },
      'agent-sessions: schedule usage-limit failover threw (left failed for next cron)',
    );
  }
}

/**
 * ISS-572 — THE shared terminal-report finalizer for a `failed` status write.
 * Both terminal-report paths (POST /desktop/status and PATCH /:id) call this
 * once, right before persisting the status: it classifies a usage/session-
 * limit failure and, on a hit, stamps `failureReason: 'usage_limit'` plus a
 * `limitResetAt` metadata merge onto the pending update `set`. The returned
 * `recoverAfterWrite` runs AFTER the status write has persisted (best-effort,
 * schedule runs only) so a recovery failure can never break the write.
 *
 * The call sites keep their own gating + inputs (message source, terminal
 * note, metadata base) — only this classify+stamp+recover core is shared.
 */
export async function finalizeUsageLimitOnFailure(opts: {
  sessionId: string;
  messages: unknown;
  note: string | null | undefined;
  /** Metadata base for the `limitResetAt` merge (caller-resolved precedence). */
  baseMetadata: Record<string, unknown> | null | undefined;
  /** Pending update object the status write will persist; mutated on a hit. */
  set: Record<string, unknown>;
}): Promise<{
  hit: boolean;
  resetAt: string | null;
  /** Post-write schedule failover; no-op unless the classification hit. */
  recoverAfterWrite: (metadata: unknown) => Promise<void>;
}> {
  const det = await detectUsageLimitFromSession(opts.messages, opts.note);
  if (det.hit) {
    opts.set.failureReason = 'usage_limit';
    opts.set.metadata = {
      ...(opts.baseMetadata ?? {}),
      ...(det.resetAt ? { limitResetAt: det.resetAt } : {}),
    };
  }
  return {
    hit: det.hit,
    resetAt: det.resetAt,
    recoverAfterWrite: async (metadata: unknown) => {
      if (!det.hit) return;
      await recoverScheduleOnUsageLimit(opts.sessionId, metadata, det.resetAt);
    },
  };
}
