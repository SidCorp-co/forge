import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { issues } from '../../db/schema.js';
import { logger } from '../../logger.js';
import { deviceRoom } from '../../ws/rooms.js';
import { roomManager } from '../../ws/server.js';
import type {
  DispatchInput,
  DispatchResult,
  HealthInput,
  HealthResult,
  RunnerAdapter,
} from '../types.js';

/** `ISS-<seq>` for an issue-bound job. Null for `pm`/`interactive`/`system`
 *  jobs, and on any lookup failure — the runner treats an absent key as "do not
 *  salvage", which is the safe direction. */
async function issueKeyOf(issueId: string | null): Promise<string | null> {
  if (!issueId) return null;
  try {
    const [row] = await db
      .select({ issSeq: issues.issSeq })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1);
    return row ? `ISS-${row.issSeq}` : null;
  } catch (err) {
    logger.warn({ err, issueId }, 'claude-code adapter: issue key lookup failed');
    return null;
  }
}

export const claudeCodeConfigSchema = z
  .object({
    skillsDir: z.string().optional(),
    claudeBinary: z.string().optional(),
    sessionTtlSec: z.number().int().positive().optional(),
  })
  .strict();

export const claudeCodeAdapter: RunnerAdapter = {
  type: 'claude-code',
  configSchema: claudeCodeConfigSchema,

  validateConfig(config) {
    const r = claudeCodeConfigSchema.safeParse(config ?? {});
    if (!r.success) return { ok: false, error: r.error.message };
    return { ok: true, config: r.data };
  },

  async dispatch({ job, runner }: DispatchInput): Promise<DispatchResult> {
    if (!runner.deviceId) {
      return { status: 'failed', errorReason: 'claude-code runner missing deviceId' };
    }
    // PR-4 — per-state overrides arrive on `job.payload` (merged by the
    // dispatcher before calling adapter.dispatch). Lift them to top-level
    // WS fields so the runner can consume without re-parsing `payload`.
    const payload = (job.payload ?? {}) as Record<string, unknown>;
    const overrideForwards: Record<string, unknown> = {};
    for (const key of [
      'model',
      'allowedTools',
      'disallowedTools',
      'permissionMode',
      'timeoutSeconds',
      'mcpServersOverride',
      'sessionGroup',
      // PR-5 — dispatcher merges `claudeSessionId` into payload when resuming
      // a session group; must lift to top-level WS so the dev runner reads it
      // at `data.claudeSessionId` (use-job-handler.ts:91).
      'claudeSessionId',
    ] as const) {
      if (key in payload) overrideForwards[key] = payload[key];
    }

    const issueKey = await issueKeyOf(job.issueId);

    const delivered = roomManager.publish(deviceRoom(runner.deviceId), {
      event: 'job.assigned',
      data: {
        jobId: job.id,
        projectId: job.projectId,
        issueId: job.issueId,
        type: job.type,
        payload: job.payload,
        promptString: job.promptString ?? null,
        systemPrompt: job.systemPrompt ?? null,
        ...overrideForwards,
        runnerId: runner.id,
        runnerType: runner.type,
        dispatchedAt: job.dispatchedAt.toISOString(),
        // cm:edge contract -> packages/runner/crates/forge-runner-core/src/workspace/salvage.rs — the runner matches `issueKey` against the branches of the agent's own worktrees to find the one worth salvaging when this job fails, and writes `attempts` into that commit's `forge-attempt` trailer. Without `issueKey` the runner declines to salvage at all rather than guess between checkouts, so dropping this field silently disables the feature; both are read as optional, so an older runner ignores them.
        ...(issueKey ? { issueKey } : {}),
        attempts: job.attempts,
        // cm:edge contract -> packages/runner/crates/forge-runner-core/src/daemon/dispatch.rs — the runner keys its local session by `jobId`, so this field is its only route back to the agent_sessions row; drop it and the transcript, claudeSessionId and diff are never written.
        ...(job.agentSessionId ? { agentSessionId: job.agentSessionId } : {}),
      },
    });
    // cm:guard `publish` returns the number of OPEN sockets it wrote to, and a job.assigned frame is the ONLY delivery — the runner has no catch-up fetch, so 0 means this job will never be claimed. Reporting `dispatched` anyway is what made a WS-dead / HTTP-heartbeat-alive device produce `dispatch_unclaimed` 4.5 minutes later, and since ISS-862 taught quarantine to count those, a core-side WS fault would have set aside every runner on the project at once. Never drop this return value again.
    // cm:why traced before shipping: the dispatcher stamps this `failed` as failureKind 'infra' with no failureAction, so `deriveActionFromKind` yields 'retry' and the job re-dispatches after RETRY_COOLDOWN_MS on the same box (3 tries, then rotate, 10 rounds) — a core deploy that drops every socket therefore costs one attempt and 60s per in-flight job, not the retry budget. No pattern in failure-classifier.ts matches this text, so nothing reclassifies it terminal.
    if (delivered === 0) {
      return {
        status: 'failed',
        errorReason:
          'dispatch not delivered: no open websocket on the device (job.assigned reached 0 subscribers)',
      };
    }
    logger.info(
      { jobId: job.id, runnerId: runner.id, deviceId: runner.deviceId, delivered },
      'claude-code adapter: published job.assigned',
    );
    return { status: 'dispatched' };
  },

  async health({ runner }: HealthInput): Promise<HealthResult> {
    // Health derived from `lastSeenAt` freshness; the stale-detector cron
    // flips status to offline after 90s of silence. If status is already
    // online and lastSeenAt is recent, the runner is healthy.
    if (runner.status !== 'online') {
      return { ok: false, lastError: `status=${runner.status}` };
    }
    if (!runner.lastSeenAt) {
      return { ok: false, lastError: 'no heartbeat seen' };
    }
    const ageMs = Date.now() - runner.lastSeenAt.getTime();
    if (ageMs > 90_000) {
      return { ok: false, lastError: `stale heartbeat ${Math.round(ageMs / 1000)}s` };
    }
    return { ok: true, details: { ageMs } };
  },
};
