/**
 * Turning a claimed job row into work a subagent can actually run.
 *
 * This is the half of the old dispatcher that survives: the policy state, the
 * resume decision, the MCP resolve, the preamble, the prior-attempts splice
 * and the model stamp. What died with it was the routing half — picking a
 * box and pushing a frame at it — because a master picks the box now.
 *
 * The ordering is the load-bearing part. Every step below reads something the
 * step before it decided, and the two that WRITE (the `model_used` stamp,
 * `ensureAgentSessionForJob`) come last, so a preparation that fails leaves
 * nothing behind for the release to undo.
 */

import { CONTENT_LANGUAGE_KEY } from '@forge/contracts/content-language';
import type { DispatchState, PolicyStateSource } from '@forge/contracts/project-config';
import { and, eq } from 'drizzle-orm';
import { mergeSessionMetadata } from '../agent-sessions/index.js';
import { db } from '../db/client.js';
import { devices, issues, jobs, runners } from '../db/schema.js';
import { activeIssuePrefix } from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { atLeastVersion, CLAIM_MIN_RUNNER } from '../runners/index.js';
import { ensureAgentSessionForJob } from './agent-session-link.js';
import { loadDispatchHeader } from './dispatch-header.js';
import { buildJobSystemPrompt } from './job-system-prompt.js';
import { jobsPorts } from './ports.js';
import { loadPriorAttempts, renderPriorAttemptsBlock } from './prior-attempts.js';
import { injectAfterInvocation, injectTurnLevelRules } from './prompt-inject.js';
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
 * Can this box name the agent's worktree, or would it run in the repo root?
 */
export async function canNameItsAgent(deviceId: string): Promise<boolean> {
  const [device] = await db
    .select({ v: devices.agentVersion })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  return atLeastVersion(device?.v ?? null, CLAIM_MIN_RUNNER);
}

type JobRow = typeof jobs.$inferSelect;

/**
 * The job's prompt string, headed by who dispatched it, carrying the turn rules on a resume and the
 * prior attempts on a retry. The header goes on last, so the splices still land after the brief's
 * own invocation line.
 */
async function promptStringFor(
  job: JobRow,
  resume: ReturnType<typeof finalizeResumeForDevice>,
  systemPrompt: string,
): Promise<string | null> {
  const base = (job.payload as { promptString?: unknown } | null)?.promptString;
  if (typeof base !== 'string') return null;
  const resumed =
    resume.priorClaudeSessionId && base ? injectTurnLevelRules(base, systemPrompt) : base;
  const brief =
    resume.isRetry && resumed
      ? injectAfterInvocation(
          resumed,
          renderPriorAttemptsBlock(await loadPriorAttempts(job), job.attempts),
        )
      : resumed;
  if (!brief.trim()) return brief;
  return `${await loadDispatchHeader(job)}\n${brief}`;
}

async function recordSessionContext(
  agentSessionId: string,
  built: Awaited<ReturnType<typeof buildJobSystemPrompt>>,
): Promise<void> {
  const { designs, requirement, contracts, pinnedContracts } = built;
  const context = jobsPorts().jobContext;
  if (designs.length || requirement) {
    await context.recordArtifactContext(
      agentSessionId,
      designs,
      requirement ? 'baseline-pins+requirement' : 'workflow-builds',
      requirement,
      pinnedContracts,
    );
  }
  // the language the preamble told this job is on its session beside `artifactContext`, so a
  // reader sees what it was asked to write in without replaying the prompt
  if (built.contentLanguage) {
    await mergeSessionMetadata(agentSessionId, { [CONTENT_LANGUAGE_KEY]: built.contentLanguage });
  }
  if (contracts.length)
    await context.recordContractContext(agentSessionId, contracts, 'issue-paths');
}

/**
 * Prepare a job a master has just claimed on `deviceId`.
 *
 * Throws if the box has no runner bound to the job's project — that box cannot
 * run this work and saying so is the whole point.
 */
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

  const resume = finalizeResumeForDevice(await resolveResumePolicy({ job }), args.deviceId);

  const [issueRow, issuePrefix] = await Promise.all([
    job.issueId
      ? db.select({ issSeq: issues.issSeq }).from(issues).where(eq(issues.id, job.issueId)).limit(1)
      : Promise.resolve([]),
    activeIssuePrefix(job.projectId),
  ]);
  const built = await buildJobSystemPrompt({
    projectId: job.projectId,
    issueId: job.issueId,
    step: job.type,
    policy: args.policy,
    subject: `prepare refused job ${job.id}`,
  });
  const { systemPrompt, deniedTools } = built;

  const promptString = await promptStringFor(job, resume, systemPrompt);
  const { model, revision, status, from, profile, qa } = args.policy;
  const issueKey =
    issueRow[0]?.issSeq == null ? null : formatIssueRef(issuePrefix, issueRow[0].issSeq);
  await db.update(jobs).set({ modelUsed: model }).where(eq(jobs.id, job.id));

  const agentSessionId = await ensureAgentSessionForJob(
    { ...job, runnerId: runner.id, deviceId: args.deviceId },
    { repoPath, resume: resume.record },
  );
  await recordSessionContext(agentSessionId, built);

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
    policy: { revision, status, from, profile, qa },
  };
}
