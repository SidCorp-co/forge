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
import { devices, issueLabels, issues, jobs, labels, projects, runners } from '../db/schema.js';
import { activeIssuePrefix } from '../issues/issue-prefix-read.js';
import { buildPipelinePreambleStructured } from '../lib/chat-preamble.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { logger } from '../logger.js';
import { injectAfterInvocation, injectTurnLevelRules } from '../prompt/user.js';
import { AGENT_NAMING_MIN_RUNNER, atLeastVersion } from '../runners/device-cap.js';
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

/**
 * The runner row that will actually host this job, refused by name when absent.
 */
export async function resolveRunnerForDevice(
  projectId: string,
  deviceId: string,
): Promise<{ id: string; type: string }> {
  const [runner] = await db
    .select({ id: runners.id, type: runners.type })
    .from(runners)
    .where(and(eq(runners.projectId, projectId), eq(runners.deviceId, deviceId)))
    .limit(1);
  if (!runner) {
    throw new Error(`prepare: device ${deviceId} has no runner bound to project ${projectId}`);
  }
  return runner;
}

export interface PreparedJob {
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
  sessionResidencySeconds?: number;
}

/**
 * How long a resident session may sit idle. The process model is no longer sent
 * with it: every job runs duplex, and ISS-941 dropped the constant that said so.
 */
async function sessionSettingsOf(projectId: string): Promise<{
  agentConfig: unknown;
  settings: { sessionResidencySeconds?: number };
}> {
  const [row] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const cfg = (row?.agentConfig ?? {}) as {
    pipelineConfig?: { sessionResidencySeconds?: unknown };
  };
  const secs = cfg.pipelineConfig?.sessionResidencySeconds;
  return {
    agentConfig: row?.agentConfig ?? null,
    settings: {
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
/**
 * Can this box name the agent's worktree, or would it run in the repo root?
 */
export async function canNameItsAgent(deviceId: string): Promise<boolean> {
  const [device] = await db
    .select({ v: devices.agentVersion })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  return atLeastVersion(device?.v ?? null, AGENT_NAMING_MIN_RUNNER);
}

export async function prepareClaimedJob(args: {
  jobId: string;
  deviceId: string;
}): Promise<PreparedJob> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, args.jobId)).limit(1);
  if (!job) throw new Error(`prepare: job ${args.jobId} not found`);

  const runner = await resolveRunnerForDevice(job.projectId, args.deviceId);

  const overrides = await resolveStageOverrides(job.projectId, job.payload);
  const proposedResume = await resolveResumePolicy({ job, overrides, agentConfig: undefined });
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

  const resumedPromptString =
    resume.priorClaudeSessionId && basePromptString
      ? injectTurnLevelRules(basePromptString, systemPrompt)
      : basePromptString;

  const promptString =
    resume.isRetry && resumedPromptString
      ? injectAfterInvocation(
          resumedPromptString,
          renderPriorAttemptsBlock(await loadPriorAttempts(job), job.attempts),
        )
      : resumedPromptString;

  const model = stageOverrides.model ?? job.modelTier ?? 'default';
  const repoPath = await loadRepoPath(job.projectId);

  const [project, issueRow, issuePrefix] = await Promise.all([
    sessionSettingsOf(job.projectId),
    job.issueId
      ? db.select({ issSeq: issues.issSeq }).from(issues).where(eq(issues.id, job.issueId)).limit(1)
      : Promise.resolve([]),
    activeIssuePrefix(job.projectId),
  ]);
  const issueKey =
    issueRow[0]?.issSeq == null ? null : formatIssueRef(issuePrefix, issueRow[0].issSeq);
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
