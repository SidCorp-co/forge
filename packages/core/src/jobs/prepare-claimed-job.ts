/**
 * Turning a claimed job row into work a subagent can actually run.
 *
 * This is the half of the old dispatcher that survives: stage overrides, the
 * resume decision, the MCP resolve, the preamble, the prior-attempts splice
 * and the prompt snapshot. What died with it was the routing half — picking a
 * box and pushing a frame at it — because a master picks the box now.
 *
 * The ordering is the load-bearing part. Every step below reads something the
 * step before it decided, and the two that WRITE (`persistPromptSnapshot`,
 * `ensureAgentSessionForJob`) come last, so a preparation that fails leaves
 * nothing behind for the release to undo.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueLabels, issues, jobs, labels, projects, runners } from '../db/schema.js';
import { buildPipelinePreambleStructured } from '../lib/chat-preamble.js';
import { logger } from '../logger.js';
import { injectAfterInvocation, injectTurnLevelRules } from '../prompt/user.js';
import { ensureAgentSessionForJob } from './agent-session-link.js';
import { loadPriorAttempts, renderPriorAttemptsBlock } from './prior-attempts.js';
import { persistPromptSnapshot } from './prompt-snapshot.js';
import { resolveJobMcpServers } from './resolve-job-mcp-servers.js';
import { finalizeResumeForDevice, resolveResumePolicy } from './resume-policy.js';
import {
  applySkillMaintenanceCarveout,
  resolveStageOverrides,
  SKILL_MAINTENANCE_LABEL,
  type StageOverrides,
} from './stage-overrides.js';

export interface PreparedJob {
  // cm:edge contract -> packages/runner/crates/forge-runner-core/src/daemon/dispatch.rs — identity travels WITH the preparation, never from the runner's own pool read. A pool entry is a snapshot the master may have been holding for minutes; rebuilding the job's identity from it is the mismatch `prepareClaimedJob` refuses one guard down, arriving by a different door.
  jobId: string;
  projectId: string;
  issueId: string | null;
  type: string;
  agentSessionId: string;
  systemPrompt: string;
  promptString: string | null;
  payload: Record<string, unknown>;
  model: string;
  repoPath: string | null;
  priorClaudeSessionId: string | null;
  runnerId: string;
  runnerType: string;
  attempts: number;
  sessionMode: 'print' | 'duplex';
  sessionResidencySeconds?: number;
}

/**
 * The project's process model, and how long a duplex session may sit idle.
 */
// cm:guard defaults to `print` for an absent project, an absent config or an absent key — duplex is opt-in per project (ISS-873 phase 3) and a read that failed must never be the thing that flips a project's process model. `pipelineConfig` is not parsed through its Zod schema here on purpose: a config that fails validation for an unrelated key must not stop the job going out.
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

/**
 * Flatten stage overrides into the payload shape a runner consumes. Null
 * fields are skipped so a job with no stage stamped emits an unchanged
 * payload.
 */
function buildOverridesPayload(o: StageOverrides): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (o.model !== null) out.model = o.model;
  if (o.allowedTools !== null) out.allowedTools = o.allowedTools.join(',');
  if (o.disallowedTools !== null) out.disallowedTools = o.disallowedTools.join(',');
  if (o.permissionMode !== null) out.permissionMode = o.permissionMode;
  if (o.timeoutSeconds !== null) out.timeoutSeconds = o.timeoutSeconds;
  if (o.mcpServers !== null) out.mcpServersOverride = o.mcpServers;
  return out;
}

async function loadRepoPath(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ repoPath: projects.repoPath, agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) return null;
  if (row.repoPath) return row.repoPath;
  const ac = (row.agentConfig ?? {}) as Record<string, unknown>;
  return typeof ac.repoPath === 'string' ? ac.repoPath : null;
}

/**
 * Give a `code`/`fix` job on a skill-maintenance issue its skill-write tools
 * back. Best-effort: an absent label leaves the overrides untouched.
 */
// cm:guard read the human-applied LABEL, never `issue.category` — the category is LLM-set and mis-classifying it hands skill-write tools to a job nobody meant to grant them to.
async function applyCarveout(
  job: typeof jobs.$inferSelect,
  overrides: StageOverrides,
): Promise<void> {
  if (!job.issueId || (job.type !== 'code' && job.type !== 'fix')) return;
  try {
    const [labelRow] = await db
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.projectId, job.projectId), eq(labels.name, SKILL_MAINTENANCE_LABEL)))
      .limit(1);
    let hasSkillMaintenanceLabel = false;
    if (labelRow) {
      const [issueLabelRow] = await db
        .select({ issueId: issueLabels.issueId })
        .from(issueLabels)
        .where(and(eq(issueLabels.issueId, job.issueId), eq(issueLabels.labelId, labelRow.id)))
        .limit(1);
      hasSkillMaintenanceLabel = Boolean(issueLabelRow);
    }
    const removed = applySkillMaintenanceCarveout(overrides, {
      hasSkillMaintenanceLabel,
      jobType: job.type,
    });
    if (removed > 0) {
      logger.info(
        { jobId: job.id, issueId: job.issueId, jobType: job.type, removed },
        'prepare: skill-maintenance carve-out unblocked skill-write tools',
      );
    }
  } catch (err) {
    logger.warn(
      { err, jobId: job.id, issueId: job.issueId, type: job.type },
      'prepare: skill-maintenance label lookup failed, preparing without carve-out',
    );
  }
}

/**
 * Prepare a job a master has just claimed on `deviceId`.
 *
 * Throws if the box has no runner bound to the job's project — that box cannot
 * run this work and saying so is the whole point.
 */
// cm:guard call this AFTER the claim transaction commits, never inside it. Both writes at the end go through the module-level `db` rather than a passed `tx`, so a preparation placed inside would survive a rollback and leave a session row plus a prompt snapshot for a hold that never landed.
// cm:guard the device is an ARGUMENT and is never re-picked here. The master already decided which box runs this, and a second opinion about the device is how the session row and the process that starts end up describing different machines.
export async function prepareClaimedJob(args: {
  jobId: string;
  deviceId: string;
}): Promise<PreparedJob> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, args.jobId)).limit(1);
  if (!job) throw new Error(`prepare: job ${args.jobId} not found`);

  const [runner] = await db
    .select({ id: runners.id, type: runners.type })
    .from(runners)
    .where(and(eq(runners.projectId, job.projectId), eq(runners.deviceId, args.deviceId)))
    .limit(1);
  // cm:guard refuse by NAME rather than falling back to any runner of the project. A prepared job whose session row points at a different box than the process that runs it is the silent substitution `CLAUDE.md` forbids: the operator loses the diff, not ten minutes.
  if (!runner) {
    throw new Error(
      `prepare: device ${args.deviceId} has no runner bound to project ${job.projectId}`,
    );
  }

  const overrides = await resolveStageOverrides(job.projectId, job.payload);
  const proposedResume = await resolveResumePolicy({ job, overrides, agentConfig: undefined });
  // cm:edge ordering -> packages/core/src/jobs/resume-policy.ts — the resume is provisional until a device is known; here the master has already chosen one, so it is finalised against that box rather than against a selector's answer
  const resume = finalizeResumeForDevice(proposedResume, args.deviceId);

  const stageOverrides = { ...overrides };
  await applyCarveout(job, stageOverrides);

  const resolvedMcp = await resolveJobMcpServers({
    projectId: job.projectId,
    stageMcpServers: stageOverrides.mcpServers,
    stageDeclaredNames: stageOverrides.declaredNames,
  });
  stageOverrides.mcpServers = resolvedMcp.mcpServers;

  const { content: systemPrompt, blocks } = await buildPipelinePreambleStructured(job.projectId, {
    step: job.type,
    override: stageOverrides.systemPrompt,
    mcpDiagnostics: { resolved: resolvedMcp.resolvedNames, dropped: resolvedMcp.droppedNames },
  });

  const payloadIn = (job.payload ?? {}) as { promptString?: unknown } & Record<string, unknown>;
  const basePromptString =
    typeof payloadIn.promptString === 'string' ? payloadIn.promptString : null;

  // cm:why on --resume the Claude CLI may ignore --append-system-prompt (undocumented), so the state's system prompt is embedded redundantly at the head of the user prompt; a fresh start gets it through the flag and needs no copy
  const resumedPromptString =
    resume.priorClaudeSessionId && basePromptString
      ? injectTurnLevelRules(basePromptString, systemPrompt)
      : basePromptString;

  // cm:edge contract -> packages/core/src/jobs/prior-attempts.ts — spliced HERE, at preparation, not by `buildJobPromptString` at enqueue: `retry.ts` copies the parent's `payload.promptString` verbatim, so a block added at enqueue time would describe the parent's own attempt rather than the one that just failed
  const promptString =
    resume.isRetry && resumedPromptString
      ? injectAfterInvocation(
          resumedPromptString,
          renderPriorAttemptsBlock(await loadPriorAttempts(job), job.attempts),
        )
      : resumedPromptString;

  const model = stageOverrides.model ?? job.modelTier ?? 'default';
  const repoPath = await loadRepoPath(job.projectId);

  const [project, issueRow] = await Promise.all([
    sessionSettingsOf(job.projectId),
    job.issueId
      ? db.select({ issSeq: issues.issSeq }).from(issues).where(eq(issues.id, job.issueId)).limit(1)
      : Promise.resolve([]),
  ]);
  // cm:guard `issueKey` no longer names any checkout. It used to be the agent's branch, and salvage found the tree by matching it; since the master names its own agent the branch is the master's word and salvage matches that exactly, so this is now prompt/display context only. Do not rebuild a branch name from it anywhere — a master that groups two issues into one agent has a branch no issue key predicts.
  const issueKey = issueRow[0]?.issSeq == null ? null : `ISS-${issueRow[0].issSeq}`;
  await persistPromptSnapshot({
    jobId: job.id,
    systemPrompt,
    userPrompt: promptString ?? '',
    blocks,
    model,
  });

  const agentSessionId = await ensureAgentSessionForJob(
    { ...job, runnerId: runner.id, deviceId: args.deviceId },
    { repoPath, resume: resume.record },
  );
  // cm:guard a job with no session row is work NOBODY CAN WATCH, so refuse it loudly here rather than handing it over. `agent_sessions` is the whole observation channel of this design — a master reads `job_events.seq` standing still to tell a stuck subagent from a slow one, and a subagent with no session writes no events at all, which is indistinguishable from one that finished. `ensureAgentSessionForJob` swallows its own errors and answers null, so this is the only place the gap is visible.
  if (!agentSessionId) {
    throw new Error(`prepare: no agent session could be created for job ${job.id}`);
  }

  return {
    jobId: job.id,
    projectId: job.projectId,
    issueId: job.issueId,
    type: job.type,
    agentSessionId,
    systemPrompt,
    promptString,
    payload: {
      ...((job.payload ?? {}) as Record<string, unknown>),
      ...buildOverridesPayload(stageOverrides),
      ...(issueKey ? { issueKey } : {}),
      ...(resume.priorClaudeSessionId ? { claudeSessionId: resume.priorClaudeSessionId } : {}),
    },
    model,
    repoPath,
    priorClaudeSessionId: resume.priorClaudeSessionId ?? null,
    runnerId: runner.id,
    runnerType: runner.type,
    attempts: job.attempts,
    ...project.settings,
  };
}
