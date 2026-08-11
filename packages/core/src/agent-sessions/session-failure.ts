import { logger } from '../logger.js';
import {
  type FailureAction,
  type FailureKind,
  classifyFailure,
} from '../pipeline/failure-classifier.js';
import { parseUsageLimitReset } from '../runners/limit-detect.js';
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
  opts?: { excludeRoles?: string[] },
): string {
  const parts: string[] = [];
  if (typeof note === 'string' && note.trim()) parts.push(note);
  if (Array.isArray(messages)) {
    for (const m of messages.slice(-6)) {
      if (m && typeof m === 'object') {
        const role = (m as { role?: unknown }).role;
        if (opts?.excludeRoles && typeof role === 'string' && opts.excludeRoles.includes(role)) {
          continue;
        }
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
 * ISS-824 — recover a schedule run the classifier routed to `failover` (device-
 * exhaustion classes: usage/session limit, org spend cap, cc-startup-death) by
 * failing over to a device whose account has headroom (reuses the loop-monitor
 * failover). No headroom device → the schedule's next cron tick recovers once
 * the window resets. Best-effort — never throws (a recovery failure must not
 * break the status write that already persisted the classified reason).
 */
export async function recoverScheduleOnFailoverAction(
  sessionId: string,
  metadata: unknown,
  reason: string,
): Promise<void> {
  const meta = (metadata ?? {}) as Record<string, unknown>;
  if (meta.source !== 'schedule.run') return;
  try {
    const { redispatchScheduleSessionOnFailover } = await import('../schedules/dispatch.js');
    const result = await redispatchScheduleSessionOnFailover(sessionId);
    logger.info(
      { sessionId, scheduleId: meta.scheduleId, reason, result },
      'agent-sessions: schedule failure classified as failover → cross-account failover',
    );
  } catch (err) {
    logger.error(
      { err, sessionId, scheduleId: meta.scheduleId },
      'agent-sessions: schedule failover threw (left failed for next cron)',
    );
  }
}

/**
 * ISS-824 — THE shared terminal-report finalizer for a `failed` status write.
 * Both terminal-report paths (POST /desktop/status and PATCH /:id) call this
 * once, right before persisting the status: it asks the SAME classifier the
 * job path asks (`classifyFailure`) instead of a bespoke regex, then always
 * stamps a `failureReason` onto the pending update `set` — `unclassified`
 * included, so a failure that matches nothing is still recorded (never left
 * NULL). `runners/limit-detect.ts` is used only for the reset-time detail on
 * an `action:'failover'` hit; the routing decision is the classifier's.
 *
 * The returned `recoverAfterWrite` runs AFTER the status write has persisted
 * (best-effort, schedule runs only) so a recovery failure can never break the
 * write. The call sites keep their own gating + inputs (message source,
 * terminal note, metadata base) — only this classify+stamp+recover core is
 * shared.
 */
export async function finalizeScheduleSessionFailure(opts: {
  sessionId: string;
  messages: unknown;
  note: string | null | undefined;
  /** Metadata base for the `limitResetAt` merge (caller-resolved precedence). */
  baseMetadata: Record<string, unknown> | null | undefined;
  /** Pending update object the status write will persist; mutated always. */
  set: Record<string, unknown>;
}): Promise<{
  kind: FailureKind;
  action: FailureAction;
  reason: string;
  /** Post-write schedule failover; no-op unless the classifier said `failover`. */
  recoverAfterWrite: (metadata: unknown) => Promise<void>;
}> {
  const text = extractSessionFailureText(opts.messages, opts.note);
  const classified = classifyFailure({ error: text });

  opts.set.failureReason = classified.reason;

  if (classified.action === 'failover') {
    const reset = parseUsageLimitReset(text);
    opts.set.metadata = {
      ...(opts.baseMetadata ?? {}),
      ...(reset ? { limitResetAt: reset.toISOString() } : {}),
    };
  }

  return {
    kind: classified.kind,
    action: classified.action,
    reason: classified.reason,
    recoverAfterWrite: async (metadata: unknown) => {
      if (classified.action !== 'failover') return;
      await recoverScheduleOnFailoverAction(opts.sessionId, metadata, classified.reason);
    },
  };
}
