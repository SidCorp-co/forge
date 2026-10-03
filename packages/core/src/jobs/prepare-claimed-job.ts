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
import { devices, issueLabels, issues, jobs, labels, runners } from '../db/schema.js';
import {
  contractsNamedIn,
  type LoadedNamedContract,
  loadNamedContracts,
  NamedContractError,
  recordNamedContracts,
  renderNamedContracts,
} from '../ecosystem/contract/named-context.js';
import {
  type LoadedContract,
  pathsNamedIn,
  renderContractContext,
} from '../ecosystem/contract/run-context.js';
import {
  loadContractContext,
  recordContractContext,
} from '../ecosystem/contract/run-context-service.js';
import { activeIssuePrefix } from '../issues/issue-prefix-read.js';
import { buildPipelinePreambleStructured, type PreambleBlock } from '../lib/chat-preamble.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { estimateTokens } from '../lib/token-estimator.js';
import { logger } from '../logger.js';
import type { DispatchState, PolicyStateSource } from '../project-config/dispatch-policy.js';
import { injectAfterInvocation, injectTurnLevelRules } from '../prompt/user.js';
import { AGENT_NAMING_MIN_RUNNER, atLeastVersion } from '../runners/device-cap.js';
import {
  ArtifactContextError,
  type LoadedArtifact,
  type LoadedRequirement,
  RequirementContextError,
  renderArtifactContext,
} from '../workflows/run-context.js';
import {
  loadArtifactContext,
  loadRequirementContext,
  recordArtifactContext,
} from '../workflows/run-context-service.js';
import { ensureAgentSessionForJob } from './agent-session-link.js';
import { SKILL_MAINTENANCE_LABEL, withSkillMaintenanceCarveout } from './job-policy.js';
import { loadPriorAttempts, renderPriorAttemptsBlock } from './prior-attempts.js';
import { persistPromptSnapshot } from './prompt-snapshot.js';
import { finalizeResumeForDevice, resolveResumePolicy } from './resume-policy.js';

/**
 * The device binding that will actually host this job, refused by name when absent. Its checkout
 * is the job's working directory: nothing else names one.
 */
export async function resolveRunnerForDevice(
  projectId: string,
  deviceId: string,
): Promise<{ id: string; type: string; repoPath: string | null }> {
  const [runner] = await db
    .select({ id: runners.id, type: runners.type, repoPath: runners.repoPath })
    .from(runners)
    .where(and(eq(runners.projectId, projectId), eq(runners.deviceId, deviceId)))
    .limit(1);
  if (!runner) {
    throw new Error(`prepare: device ${deviceId} has no runner bound to project ${projectId}`);
  }
  const repoPath = runner.repoPath?.trim() ? runner.repoPath.trim() : null;
  return { ...runner, repoPath };
}

export function checkoutUnboundMessage(
  projectId: string,
  deviceId: string,
  runnerId: string,
): string {
  return `CHECKOUT_UNBOUND: device ${deviceId}'s binding to project ${projectId} (runner ${runnerId}) names no checkout, so no job runs there. The binding is the only place a checkout is named: set it with \`forge-runner bind <slug> --path <dir>\` on the box, or PATCH /api/projects/${projectId}/runners/${runnerId} { repoPath }.`;
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
  /** The device binding's checkout, where the job's pane is opened. */
  repoPath: string;
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

// cm:why a run is given the contracts its issue's named paths reach before it starts, since the paths it will change are not known yet; it asks forge_ecosystem action=context for paths it finds later
async function contractsNamedBy(
  job: typeof jobs.$inferSelect,
  issue:
    | { description: string | null; plan: string | null; acceptanceCriteria: string | null }
    | undefined,
): Promise<LoadedContract[]> {
  if (!issue) return [];
  const text = [issue.description, issue.plan, issue.acceptanceCriteria].filter(Boolean).join('\n');
  try {
    return await loadContractContext(job.projectId, pathsNamedIn(text));
  } catch (err) {
    // cm:guard a run whose contract context cannot be read is refused, never prepared without it — it would edit a call site blind (owner, 2026-10-02)
    throw new Error(
      `CONTRACT_CONTEXT_UNLOADABLE: prepare refused job ${job.id}: the contracts its issue's paths reach could not be read (${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    );
  }
}

// cm:why a job is given the contract versions its issue names, the provider's and the in-project consumer's view alike, where path matching reaches only a link's call sites
async function contractVersionsNamedBy(
  job: typeof jobs.$inferSelect,
  issue:
    | { description: string | null; plan: string | null; acceptanceCriteria: string | null }
    | undefined,
): Promise<LoadedNamedContract[]> {
  if (!issue) return [];
  const text = [issue.description, issue.plan, issue.acceptanceCriteria].filter(Boolean).join('\n');
  try {
    return await loadNamedContracts(job.projectId, contractsNamedIn(text));
  } catch (err) {
    // cm:guard a named contract version that cannot be given, or is not approved, refuses the job by name: it would build against a contract nobody agreed
    const code = err instanceof NamedContractError ? err.code : 'CONTRACT_CONTEXT_UNLOADABLE';
    throw new Error(
      `${code}: prepare refused job ${job.id}: the contract versions its issue names could not be given (${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    );
  }
}

// cm:why a build job is given the design revision its approver approved, so it builds the journey it was held for rather than one it guesses at; an issue that builds no workflow is given nothing
async function designsBuiltBy(job: typeof jobs.$inferSelect): Promise<LoadedArtifact[]> {
  if (!job.issueId) return [];
  try {
    return await loadArtifactContext(job.issueId);
  } catch (err) {
    // cm:guard an unreadable approved revision stops the job as `ARTIFACT_CONTEXT_UNLOADABLE`: an agent given no design would build the journey blind
    const code = err instanceof ArtifactContextError ? err.code : 'ARTIFACT_CONTEXT_UNLOADABLE';
    throw new Error(
      `${code}: prepare refused job ${job.id}: the approved design its issue builds could not be given (${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    );
  }
}

// cm:why a job on an issue that delivers a requirement is given its current revision's business criteria and the design revisions its baseline pins, so it builds what was agreed rather than what the description paraphrased
async function requirementServedBy(
  job: typeof jobs.$inferSelect,
): Promise<LoadedRequirement | null> {
  if (!job.issueId) return null;
  try {
    return await loadRequirementContext(job.issueId);
  } catch (err) {
    // cm:guard a requirement that cannot be given at its current revision stops the job by name: a run given a superseded or unagreed revision would build the wrong intent
    const code = err instanceof RequirementContextError ? err.code : 'ARTIFACT_CONTEXT_UNLOADABLE';
    throw new Error(
      `${code}: prepare refused job ${job.id}: the requirement its issue delivers could not be given (${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    );
  }
}

function withContextBlock(
  prior: { systemPrompt: string; blocks: PreambleBlock[] },
  id: PreambleBlock['id'],
  body: string | null,
): { systemPrompt: string; blocks: PreambleBlock[] } {
  if (!body) return prior;
  return {
    systemPrompt: `${prior.systemPrompt}\n\n${body}`,
    blocks: [
      ...prior.blocks,
      { id, kind: 'system', chars: body.length, estTokens: estimateTokens(body) },
    ],
  };
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
  const repoPath = runner.repoPath;
  if (!repoPath) {
    throw new Error(checkoutUnboundMessage(job.projectId, args.deviceId, runner.id));
  }

  const proposedResume = await resolveResumePolicy({ job });
  const resume = finalizeResumeForDevice(proposedResume, args.deviceId);

  const deniedTools = await applyCarveout(job, args.policy.deniedTools);

  const preamble = await buildPipelinePreambleStructured(job.projectId, {
    step: job.type,
    policy: { ...args.policy, deniedTools },
  });

  const [issueRow, issuePrefix] = await Promise.all([
    job.issueId
      ? db
          .select({
            issSeq: issues.issSeq,
            description: issues.description,
            plan: issues.plan,
            acceptanceCriteria: issues.acceptanceCriteria,
          })
          .from(issues)
          .where(eq(issues.id, job.issueId))
          .limit(1)
      : Promise.resolve([]),
    activeIssuePrefix(job.projectId),
  ]);
  const designs = await designsBuiltBy(job);
  const requirement = await requirementServedBy(job);
  const contracts = await contractsNamedBy(job, issueRow[0]);
  const namedContracts = await contractVersionsNamedBy(job, issueRow[0]);
  const artifactBlock =
    [requirement?.text, renderArtifactContext(designs)].filter(Boolean).join('\n\n') || null;
  const { systemPrompt, blocks } = withContextBlock(
    withContextBlock(
      withContextBlock(
        { systemPrompt: preamble.content, blocks: preamble.blocks },
        'artifact-context',
        artifactBlock,
      ),
      'contract-context',
      renderContractContext(contracts),
    ),
    'named-contract-context',
    renderNamedContracts(job.projectId, namedContracts),
  );

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
  if (designs.length || requirement) {
    await recordArtifactContext(
      agentSessionId,
      designs,
      requirement ? 'workflow-builds+requirement' : 'workflow-builds',
      requirement,
    );
  }
  if (contracts.length) await recordContractContext(agentSessionId, contracts, 'issue-paths');
  if (namedContracts.length) await recordNamedContracts(agentSessionId, namedContracts);

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
