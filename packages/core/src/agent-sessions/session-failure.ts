import { logger } from '../logger.js';
import type { FailureCause } from '../pipeline/failure-causes.js';
import {
  classifyFailure,
  type FailureAction,
  type FailureKind,
} from '../pipeline/failure-classifier.js';
import { parseUsageLimitReset } from '../runners/limit-detect.js';
import { extractPromptString } from './turns-helpers.js';

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
 * ISS-875 — the classifier's reason is `<class> → <predicted disposition>`
 * (`usage/session limit → cross-device failover`). Only the class half is a
 * fact at classification time; the failover path re-states the other half from
 * what it actually did.
 */
export function failureClassOf(reason: string): string {
  const [head] = reason.split(' → ');
  return (head as string).trim() || reason;
}

/**
 * ISS-824 — recover a schedule run the classifier routed to `failover` (device-
 * exhaustion classes: usage/session limit, org spend cap, cc-startup-death) by
 * failing over to a device whose account has headroom (reuses the loop-monitor
 * failover). Best-effort — never throws (a recovery failure must not break the
 * status write that already persisted the classified reason).
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
    const result = await redispatchScheduleSessionOnFailover(sessionId, {
      failureClass: failureClassOf(reason),
    });
    logger.info(
      { sessionId, scheduleId: meta.scheduleId, reason, result },
      'agent-sessions: schedule failure classified as failover',
    );
  } catch (err) {
    logger.error(
      { err, sessionId, scheduleId: meta.scheduleId },
      'agent-sessions: schedule failover threw (left failed for next cron)',
    );
  }
}

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
  cause: FailureCause;
  reason: string;
  /** Post-write schedule failover; no-op unless the classifier said `failover`. */
  recoverAfterWrite: (metadata: unknown) => Promise<void>;
}> {
  const text = extractSessionFailureText(opts.messages, opts.note, { excludeRoles: ['user'] });
  const classified = classifyFailure({ error: text });

  opts.set.failureReason = classified.cause;
  opts.set.failureDetail = classified.reason || null;

  const base = (opts.baseMetadata ?? {}) as Record<string, unknown>;
  if (classified.action === 'failover') {
    const reset = parseUsageLimitReset(text);
    opts.set.metadata = {
      ...base,
      ...(reset ? { limitResetAt: reset.toISOString() } : {}),
    };
    if (base.source !== 'schedule.run' && base.agentChat == null) {
      opts.set.failureDetail = `${failureClassOf(classified.reason)} → no failover (plain chat session)`;
    }
  }

  return {
    kind: classified.kind,
    action: classified.action,
    cause: classified.cause,
    reason: classified.reason,
    recoverAfterWrite: async (metadata: unknown) => {
      if (classified.action !== 'failover') return;
      await recoverScheduleOnFailoverAction(opts.sessionId, metadata, classified.reason);
    },
  };
}
