/**
 * Turning a claimed job row into work a subagent can actually run.
 *
 * This is the half of the old dispatcher that survives: the policy state, the
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
import type { DispatchState, PolicyStateSource } from '../project-config/dispatch-policy.js';
import { injectAfterInvocation, injectTurnLevelRules } from '../prompt/user.js';
import { AGENT_NAMING_MIN_RUNNER, atLeastVersion } from '../runners/device-cap.js';
import { ensureAgentSessionForJob } from './agent-session-link.js';
import { SKILL_MAINTENANCE_LABEL, withSkillMaintenanceCarveout } from './job-policy.js';
import { loadPriorAttempts, renderPriorAttemptsBlock } from './prior-attempts.js';
import { persistPromptSnapshot } from './prompt-snapshot.js';
import { resolveJobMcpServers } from './resolve-job-mcp-servers.js';
import { finalizeResumeForDevice, resolveResumePolicy } from './resume-policy.js';

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
  /** The tool patterns the job's pane is started without, from its policy state's profile. */
  deniedTools: string[];
  /** Which policy revision and state decided `model` and `deniedTools`, and how the state was chosen. */
  policy: {
    revision: number;
    status: string;
    from: PolicyStateSource;
    profile: string;
    qa: DispatchState['qa'];
  };
}

async function loadRepoPath(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ repoPath: projects.repoPath })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.repoPath ?? null;
}

/**
 * Give a `code`/`fix` job on a skill-maintenance issue its skill-write tools
 * back. Best-effort: an absent label leaves the deny list untouched.
 */
async function applyCarveout(
  job: typeof jobs.$inferSelect,
  deniedTools: string[],
): Promise<string[]> {
  if (!job.issueId || (job.type !== 'code' && job.type !== 'fix')) return deniedTools;
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
    const carved = withSkillMaintenanceCarveout(deniedTools, {
      hasSkillMaintenanceLabel,
      jobType: job.type,
    });
    if (carved.length < deniedTools.length) {
      logger.info(
        {
          jobId: job.id,
          issueId: job.issueId,
          jobType: job.type,
          removed: deniedTools.length - carved.length,
        },
        'prepare: skill-maintenance carve-out unblocked skill-write tools',
      );
    }
    return carved;
  } catch (err) {
    logger.warn(
      { err, jobId: job.id, issueId: job.issueId, type: job.type },
      'prepare: skill-maintenance label lookup failed, preparing without carve-out',
    );
    return deniedTools;
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
  /** The policy state the claim resolved before it held the job (`devices/claim.ts`). */
  policy: DispatchState;
}): Promise<PreparedJob> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, args.jobId)).limit(1);
  if (!job) throw new Error(`prepare: job ${args.jobId} not found`);

  const runner = await resolveRunnerForDevice(job.projectId, args.deviceId);

  const proposedResume = await resolveResumePolicy({ job });
  const resume = finalizeResumeForDevice(proposedResume, args.deviceId);

  const deniedTools = await applyCarveout(job, args.policy.deniedTools);

  const resolvedMcp = await resolveJobMcpServers({ projectId: job.projectId });

  const { content: systemPrompt, blocks } = await buildPipelinePreambleStructured(job.projectId, {
    step: job.type,
    policy: { ...args.policy, deniedTools },
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

  const model = args.policy.model;
  const repoPath = await loadRepoPath(job.projectId);

  const [issueRow, issuePrefix] = await Promise.all([
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
      ...(issueKey ? { issueKey } : {}),
      ...(resume.priorClaudeSessionId ? { claudeSessionId: resume.priorClaudeSessionId } : {}),
    },
    model,
    repoPath,
    priorClaudeSessionId: resume.priorClaudeSessionId ?? null,
    runnerId: runner.id,
    runnerType: runner.type,
    attempts: job.attempts,
    deniedTools,
    policy: {
      revision: args.policy.revision,
      status: args.policy.status,
      from: args.policy.from,
      profile: args.policy.profile,
      qa: args.policy.qa,
    },
  };
}
