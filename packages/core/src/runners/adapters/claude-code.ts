import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { devices, issues, projects } from '../../db/schema.js';
import { issueBranchName } from '../../issues/issue-branch.js';
import { worktreeBranchPayload } from '../../issues/merged-at.js';
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
// cm:guard defaults to `print` for an absent project, an absent config or an absent key — duplex is opt-in per project (ISS-873 phase 3) and a read that failed must never be the thing that flips a project's process model. `pipelineConfig` is not parsed through its Zod schema here on purpose: this runs on every dispatch, and a config that fails validation for an unrelated key must not stop the job going out.
// cm:guard ONE read for both fields. Two calls would let the mode and the residency come from different snapshots of the same row — a job spawned duplex with the residency of a config that no longer says duplex.
async function sessionSettingsOf(projectId: string): Promise<{
  agentConfig: unknown;
  settings: { sessionMode: 'print' | 'duplex'; sessionResidencySeconds?: number };
}> {
  const [row] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const cfg = (row?.agentConfig ?? {}) as {
    pipelineConfig?: { sessionMode?: unknown; sessionResidencySeconds?: unknown };
  };
  const secs = cfg.pipelineConfig?.sessionResidencySeconds;
  return {
    agentConfig: row?.agentConfig ?? null,
    settings: {
      sessionMode: cfg.pipelineConfig?.sessionMode === 'duplex' ? 'duplex' : 'print',
      // cm:guard a positive number ONLY. The key defaults to 0 and no project has set it, so forwarding 0 would be indistinguishable on the wire from a project asking for no residency at all — the runner resolves absent and 0 to the same default for exactly that reason, and sending nothing keeps the two sides agreeing by construction.
      ...(typeof secs === 'number' && secs > 0 ? { sessionResidencySeconds: secs } : {}),
    },
  };
}

/** Runner build on the device about to take the job — the worktree lane's floor. */
async function agentVersionOf(deviceId: string): Promise<string | null> {
  const [row] = await db
    .select({ v: devices.agentVersion })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  return row?.v ?? null;
}

async function issueKeyOf(issueId: string | null): Promise<string | null> {
  if (!issueId) return null;
  try {
    const [row] = await db
      .select({ issSeq: issues.issSeq })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1);
    return row ? issueBranchName(row.issSeq) : null;
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

    const [issueKey, project, runnerVersion, patToken] = await Promise.all([
      issueKeyOf(job.issueId),
      sessionSettingsOf(job.projectId),
      agentVersionOf(runner.deviceId),
      // cm:guard imported lazily so the adapter's static graph stays free of argon2 and the env schema — the mint reaches both, and pulling them in at module load turned this file into one that cannot be imported without DATABASE_URL. Same reason `lifecycle/transition.ts` lazy-loads its bridges.
      import('../../jobs/job-token.js')
        .then((mod) => mod.mintJobToken(job))
        .catch((err) => {
          logger.error(
            { err, jobId: job.id },
            'claude-code adapter: job-token module failed to load',
          );
          return null;
        }),
    ]);
    const worktree = worktreeBranchPayload({
      status: (payload.stageStatus ?? null) as never,
      agentConfig: project.agentConfig,
      featureBranch: issueKey,
      runnerVersion,
    });

    const delivered = roomManager.publish(deviceRoom(runner.deviceId), {
      event: 'job.assigned',
      data: {
        jobId: job.id,
        projectId: job.projectId,
        issueId: job.issueId,
        type: job.type,
        payload: { ...(job.payload ?? {}), ...worktree },
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
        // cm:edge contract -> packages/runner/crates/forge-runner-core/src/transport/frames.rs — the runner exports this as `$FORGE_PAT` on the agent process, which is the ONLY way a box reaches REST without a hand-provisioned credential. Omitted when the mint failed, and an older runner ignores it, so both halves degrade to "whatever the operator set by hand" rather than to a broken job.
        ...(patToken ? { patToken } : {}),
        // cm:edge contract -> packages/runner/crates/forge-runner-core/src/daemon/dispatch.rs — the runner reads `sessionMode` to decide `Stdio::piped()` vs `-p`, and an older runner ignores it entirely and stays print. That is the whole opt-in: dropping this field does not break a job, it silently pins every project back to print and the phase-3 rollout reads as "no project ever opted in".
        // cm:edge contract -> packages/runner/crates/forge-runner-core/src/runner/claude_code.rs — `sessionResidencySeconds` rides alongside and is resolved there by `resolve_residency`, which must agree with `jobs/park-deadline.ts`'s COALESCE: core's backstop fires at this value plus a grace, so a runner reading it differently gets its park reaped while it still considers the session live.
        ...project.settings,
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
