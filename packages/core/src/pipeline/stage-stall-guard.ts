/**
 * ISS-626 — Stage-stall cap for the reconciler rescue path.
 *
 * Root cause of the 94-session spin loop (run 712a565a): a `plan` job was
 * dispatched to a device whose Claude CLI did NOT have the `forge-plan` skill
 * installed. The CLI treated `/forge-plan` as an unknown command, printed
 * "Unknown command: /forge-plan", and exited 0 / is_error=false / num_turns=0.
 * The runner trusts `is_error` (`succeeded = !is_error`), so the job was
 * recorded `done` — but no plan was written and the issue stayed at
 * `clarified`. The minute-cadence reconciler (reconciler.ts) then re-rescued
 * the still-stuck issue, minting a fresh no-op session every ~60s for ~93 min.
 *
 * Core-side (skill IS registered here — so the ISS-238 missing-skill guard,
 * which keys on a missing `skill_registrations` row, never fires) the only
 * observable signal is the pathology itself: the SAME stage completes `done`
 * repeatedly under one run without ever advancing the issue past it. This
 * guard caps that: after `STAGE_STALL_CAP` CONSECUTIVE done jobs of the stage's
 * job type, it PAUSES the run (typed reason) + posts an operator-facing
 * comment instead of letting the reconciler re-enqueue a (K+1)th no-op.
 *
 * The true root fix (treat num_turns=0 / "Unknown command" as a runner-side
 * failure) ships on the runner release train; this is the deployable-now core
 * backstop that bounds session creation and surfaces the operator-fixable
 * cause (executing device missing the skill, or a skill that runs but never
 * advances status).
 */

import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments, type IssueStatus, issues, jobs, pipelineRuns, projects } from '../db/schema.js';
import { logger } from '../logger.js';
import { type DeviceSkillStatusValue, loadDeviceSkillStatus } from '../skills/effective.js';
import { pauseReasonFor, pauseRun } from './run-pause.js';
import { createProjectSkillResolver, resolveJobTypeForStatus } from './skill-mapping.js';

/**
 * Consecutive `done` jobs of one stage type in a single run without the issue
 * advancing before the run is paused for review. 3 leaves generous headroom
 * for a couple of transient re-runs while still bounding the loop tightly
 * (the incident hit 94).
 */
export const STAGE_STALL_CAP = 3;

export const STAGE_STALL_REASON_PREFIX = 'stage_stalled:';

// cm:edge lockstep -> packages/core/src/pipeline/run-pause.ts — the kind must stay in LIVE_PAUSE_REASON_KINDS; drop it there and `resumeOrphanedPauses` frees every run this guard paused, one sweep later
export function buildStageStalledReason(stage: IssueStatus): string {
  return pauseReasonFor('stage_stalled', stage);
}

export type StageCauseVerification =
  | {
      kind: 'confirmed';
      skillLabel: string;
      evidence: Array<{ deviceId: string; status: DeviceSkillStatusValue }>;
    }
  | { kind: 'ruled_out'; skillLabel: string; checkedDeviceCount: number }
  | { kind: 'unverified'; skillLabel: string; reason: string };

export type StageStateFlag = 'yes' | 'no' | 'unknown';

export interface StageState {
  merged: StageStateFlag;
  implementationRan: StageStateFlag;
  stageProducedComment: StageStateFlag;
}

export function buildStageStalledCommentBody(args: {
  stage: IssueStatus;
  jobType: string;
  doneCount: number;
  verification: StageCauseVerification;
  state: StageState;
}): string {
  const lines = [
    `🛑 **Pipeline halted at stage \`${args.stage}\`** — the stage keeps completing without advancing.`,
    '',
    `The \`${args.jobType}\` step has finished (\`done\`) ${args.doneCount} times in this run, yet the issue never left \`${args.stage}\`. That is a no-op loop: each attempt exits cleanly but does no work, so the reconciler keeps re-dispatching it.`,
    '',
  ];

  const { verification } = args;
  if (verification.kind === 'confirmed') {
    lines.push(
      'Cause (verified):',
      `- The \`${verification.skillLabel}\` skill is **not synced** on the device(s) that ran this stage:`,
      ...verification.evidence.map((e) => `  - device \`${e.deviceId}\`: \`${e.status}\``),
      `  That would make the CLI treat \`/${verification.skillLabel}\` as an unknown command, exit 0, and record the job \`done\` with no work performed. Push the skill to the device (Skills page → sync) and resume.`,
    );
  } else if (verification.kind === 'ruled_out') {
    lines.push(
      `Skill sync ruled out as the cause: \`${verification.skillLabel}\` is \`synced\` on all ${verification.checkedDeviceCount} device(s) that ran this stage. Possible causes (unranked):`,
      `- The \`${verification.skillLabel}\` skill runs but never performs the \`${args.stage}\` status transition.`,
      '- A transient bug in the skill causes it to exit cleanly without doing the work.',
    );
  } else {
    lines.push(
      `Could not verify a cause: ${verification.reason}. Possible causes (unranked):`,
      `- The executing device's Claude CLI is missing the \`${verification.skillLabel}\` skill — the CLI then treats it as an unknown command, exits 0, and the job is recorded \`done\` with no work done.`,
      `- Or the \`${verification.skillLabel}\` skill runs but never performs the \`${args.stage}\` status transition.`,
    );
  }

  lines.push(
    '',
    '**Current state:**',
    `- Merge recorded (\`merged_at\`): ${args.state.merged}`,
    `- Implementation ran (a \`code\`/\`fix\` job completed): ${args.state.implementationRan}`,
    `- Stage produced a comment since this stall began: ${args.state.stageProducedComment}`,
    '',
    '**Exits:**',
    '- Resume the run once the cause above is addressed.',
    '- Or close this issue (force-close) if the work is no longer wanted.',
  );

  return lines.join('\n');
}

/**
 * Verify the "missing/stale skill" cause against real device-skill state
 * instead of asserting it. Never throws — any DB error degrades to
 * `unverified` so the caller can still post a (honest) comment and pause.
 */
async function verifySkillSyncCause(args: {
  projectId: string;
  status: IssueStatus;
  jobType: string;
  deviceIds: string[];
}): Promise<StageCauseVerification> {
  let skillLabel = `forge-${args.jobType}`;
  try {
    const resolved = await createProjectSkillResolver(args.projectId).resolve(args.status);
    if (resolved?.skillName) skillLabel = resolved.skillName;
  } catch (err) {
    logger.warn(
      { err, projectId: args.projectId, status: args.status },
      'stage-stall-guard: skill-name resolve failed, falling back to conventional name',
    );
  }

  if (args.deviceIds.length === 0) {
    return {
      kind: 'unverified',
      skillLabel,
      reason: 'no executing device is recorded on the stalled jobs',
    };
  }

  try {
    const evidence: Array<{ deviceId: string; status: DeviceSkillStatusValue }> = [];
    for (const deviceId of args.deviceIds) {
      const entries = await loadDeviceSkillStatus(args.projectId, deviceId);
      const entry = entries.find((e) => e.name === skillLabel);
      if (entry) evidence.push({ deviceId, status: entry.status });
    }
    if (evidence.length === 0) {
      return {
        kind: 'unverified',
        skillLabel,
        reason: `\`${skillLabel}\` is not a registered effective skill for the executing device(s)`,
      };
    }
    const nonSynced = evidence.filter((e) => e.status !== 'synced');
    if (nonSynced.length > 0) return { kind: 'confirmed', skillLabel, evidence: nonSynced };
    return { kind: 'ruled_out', skillLabel, checkedDeviceCount: evidence.length };
  } catch (err) {
    logger.warn(
      { err, projectId: args.projectId, deviceIds: args.deviceIds },
      'stage-stall-guard: skill-sync cause check failed, could not verify',
    );
    return { kind: 'unverified', skillLabel, reason: 'the skill-sync check failed to complete' };
  }
}

async function checkFlag(fn: () => Promise<boolean>): Promise<StageStateFlag> {
  try {
    return (await fn()) ? 'yes' : 'no';
  } catch (err) {
    logger.warn({ err }, 'stage-stall-guard: state check failed');
    return 'unknown';
  }
}

/**
 * Actionable current-state summary, read independently per field so one
 * failing query degrades only that field to `unknown` rather than the whole
 * summary. `windowStart` scopes the comment check to THIS stall episode (the
 * oldest job of the consecutive done-tail), not the whole run, so an earlier
 * stage's comment isn't misread as this stage's output.
 */
async function loadStageState(args: { issueId: string; windowStart: Date }): Promise<StageState> {
  const merged = await checkFlag(async () => {
    const [row] = await db
      .select({ mergedAt: issues.mergedAt })
      .from(issues)
      .where(eq(issues.id, args.issueId))
      .limit(1);
    return row?.mergedAt != null;
  });
  const implementationRan = await checkFlag(async () => {
    const [row] = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.issueId, args.issueId),
          eq(jobs.status, 'done'),
          inArray(jobs.type, ['code', 'fix']),
        ),
      )
      .limit(1);
    return Boolean(row);
  });
  const stageProducedComment = await checkFlag(async () => {
    const [row] = await db
      .select({ id: comments.id })
      .from(comments)
      .where(and(eq(comments.issueId, args.issueId), gt(comments.createdAt, args.windowStart)))
      .limit(1);
    return Boolean(row);
  });
  return { merged, implementationRan, stageProducedComment };
}

export interface StageStallCheckInput {
  projectId: string;
  issueId: string;
  status: IssueStatus;
}

/**
 * Decide whether the reconciler should refuse to re-enqueue this stuck issue
 * because its stage is stalling in a no-op loop.
 *
 * Returns `{ stalled: true }` when the caller must SKIP re-enqueue:
 *  - the open run is already paused with a `stage_stalled:` reason, or
 *  - the stage's job type has completed `done` >= STAGE_STALL_CAP times in a
 *    row, with no other stage's job done in between (in which case this call
 *    effectively pauses the run + comments).
 *
 * Returns `{ stalled: false }` for the normal rescue path (genuine crash-mid-
 * dispatch has zero done jobs of the type → count 0 → not stalled).
 */
export async function checkStageStallAndPause(
  input: StageStallCheckInput,
): Promise<{ stalled: boolean }> {
  try {
    return await checkStageStallAndPauseInner(input);
  } catch (err) {
    // FAIL-OPEN: a guard error must never block a legitimate reconciler rescue.
    logger.error(
      { err, issueId: input.issueId, status: input.status },
      'stage-stall-guard: check failed, failing open (allowing re-enqueue)',
    );
    return { stalled: false };
  }
}

async function checkStageStallAndPauseInner(
  input: StageStallCheckInput,
): Promise<{ stalled: boolean }> {
  const jobMap = resolveJobTypeForStatus(input.status);
  if (!jobMap) return { stalled: false }; // human-gated status — nothing to cap

  // Find the issue's non-terminal run (running or paused). Terminal runs are
  // left alone; a missing run means there's nothing to pause.
  const [run] = await db
    .select({
      id: pipelineRuns.id,
      status: pipelineRuns.status,
      currentStep: pipelineRuns.currentStep,
      metadata: pipelineRuns.metadata,
    })
    .from(pipelineRuns)
    .where(
      and(
        eq(pipelineRuns.issueId, input.issueId),
        eq(pipelineRuns.kind, 'issue'),
        eq(pipelineRuns.status, 'running'),
      ),
    )
    .limit(1);

  if (!run) {
    // No running run. If one is paused with our stall reason, keep refusing
    // re-enqueue (idempotent — no duplicate comment).
    const [paused] = await db
      .select({ metadata: pipelineRuns.metadata })
      .from(pipelineRuns)
      .where(
        and(
          eq(pipelineRuns.issueId, input.issueId),
          eq(pipelineRuns.kind, 'issue'),
          eq(pipelineRuns.status, 'paused'),
        ),
      )
      .limit(1);
    const reason = (paused?.metadata as Record<string, unknown> | null)?.pauseReason;
    return {
      stalled: typeof reason === 'string' && reason.startsWith(STAGE_STALL_REASON_PREFIX),
    };
  }

  // cm:guard count only the CONSECUTIVE tail of this stage's done jobs — a done job of another type in between is proof the issue advanced, which ends the no-op run this cap exists to bound
  // cm:why a lifetime count wedges `reopen` forever — it maps to `fix`, so any run that legitimately took >= 3 review->fix rounds trips the cap the instant it is reopened and every resume re-pauses within seconds (ISS-801, run ac5b4ad0: 9 healthy fix jobs)
  const recent = await db
    .select({ type: jobs.type, deviceId: jobs.deviceId, createdAt: jobs.createdAt })
    .from(jobs)
    .where(
      and(eq(jobs.issueId, input.issueId), eq(jobs.status, 'done'), eq(jobs.pipelineRunId, run.id)),
    )
    .orderBy(desc(jobs.createdAt))
    .limit(STAGE_STALL_CAP);

  const tail: Array<{ type: string; deviceId: string | null; createdAt: Date }> = [];
  for (const job of recent) {
    if (job.type !== jobMap.type) break;
    tail.push(job);
  }
  const doneCount = tail.length;
  if (doneCount < STAGE_STALL_CAP) return { stalled: false };

  // Effective pause via the shared pause writer (idempotent CAS on
  // status='running'; pauseReason merge + hook/WS side effects inside).
  const reason = buildStageStalledReason(input.status);
  const paused = await pauseRun({ runId: run.id, pauseReason: reason });

  logger.warn(
    {
      projectId: input.projectId,
      issueId: input.issueId,
      stage: input.status,
      jobType: jobMap.type,
      doneCount,
      runId: run.id,
      effectivePause: paused !== null,
    },
    'stage-stall-guard: stage completed >= cap times without advancing — pausing run, refusing re-enqueue',
  );

  const oldestTailJob = tail.at(-1);
  if (paused && oldestTailJob) {
    const deviceIds = [
      ...new Set(tail.map((j) => j.deviceId).filter((d): d is string => Boolean(d))),
    ];
    await postStageStalledComment({
      projectId: input.projectId,
      issueId: input.issueId,
      stage: input.status,
      jobType: jobMap.type,
      doneCount,
      windowStart: oldestTailJob.createdAt,
      deviceIds,
    });
  }

  return { stalled: true };
}

async function postStageStalledComment(args: {
  projectId: string;
  issueId: string;
  stage: IssueStatus;
  jobType: string;
  doneCount: number;
  windowStart: Date;
  deviceIds: string[];
}): Promise<void> {
  const [row] = await db
    .select({ createdBy: projects.createdBy })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(eq(issues.id, args.issueId))
    .limit(1);
  if (!row?.createdBy) return;

  const state = await loadStageState({ issueId: args.issueId, windowStart: args.windowStart });
  const verification = await verifySkillSyncCause({
    projectId: args.projectId,
    status: args.stage,
    jobType: args.jobType,
    deviceIds: args.deviceIds,
  });

  try {
    await db.insert(comments).values({
      issueId: args.issueId,
      authorId: row.createdBy,
      body: buildStageStalledCommentBody({
        stage: args.stage,
        jobType: args.jobType,
        doneCount: args.doneCount,
        verification,
        state,
      }),
      isAi: true,
    });
  } catch (err) {
    logger.warn(
      { err, issueId: args.issueId, stage: args.stage },
      'stage-stall-guard: failed to post comment, continuing',
    );
  }
}
