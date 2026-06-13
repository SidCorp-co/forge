import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type IssueStatus,
  type JobStatus,
  type JobType,
  jobs,
  skillRegistrations,
  skills,
} from '../db/schema.js';
import { insertAndEnqueueJob } from '../pipeline/enqueue-helper.js';
import { PIPELINE_STEPS } from '../pipeline/registry.js';
import { openOneShotRun } from '../pipeline/runs.js';
import { selectRunnerForJob } from '../runners/select.js';
import { type ProjectSkillSyncStatus, loadProjectSkillSyncStatus } from './effective.js';

/**
 * ISS-455 (Onboarding C2) — per-project skill smoke-verify.
 *
 * Produces a PER-STAGE PASS/FAIL report grounded in evidence, never in the
 * registration `synced` badge:
 *
 *   - Tier-1 (static, zero agent cost): for each pipeline stage, (a) a
 *     `scope='project'` skill is registered, and (b) a bound runner device has
 *     reported an `installedHash` matching the registry's effective hash
 *     (`device_skills` via `loadProjectSkillSyncStatus`). Known false-negative:
 *     desktop devices never report installs, so "no report" is its own
 *     WARN-style FAIL reason (`no_device_report`) — we refuse to guess.
 *
 *   - Tier-2 (opt-in canary): dispatches a real `smoke` job per stage through
 *     the normal enqueue → dispatch → runner → lifecycle path. The job is
 *     SYNTHETIC: no issue row, a one-shot `kind='system'` pipeline_run
 *     (metadata-flagged), and a prompt that forbids repo/issue mutation. The
 *     terminal result is read back off the jobs row — terminal flips happen
 *     ONLY in the existing lifecycle chokepoint (`applyKernelTransition` via
 *     lifecycle routes / sweepers); this module never writes job status.
 */

// ── report shapes ───────────────────────────────────────────────────────────

export type SmokeVerifyStatus = 'PASS' | 'FAIL';

export type SmokeTier1Reason =
  | 'not_registered' // no skill_registrations row for the stage
  | 'no_project_skill' // registration resolves to no usable project-scoped skill
  | 'no_bound_runner' // project has no claude-code runner device at all
  | 'no_device_report' // no device ever reported an install (desktop never does)
  | 'stale_on_runner'; // every reporting device's installedHash differs

export interface SmokeTier1Entry {
  stage: IssueStatus;
  jobType: JobType;
  skillId: string | null;
  skillName: string | null;
  status: SmokeVerifyStatus;
  reason: SmokeTier1Reason | null;
  detail: string | null;
  /** When this static check ran (the report is always computed fresh). */
  checkedAt: string;
  /** For PASS: the newest `device_skills.syncedAt` backing the evidence. */
  evidenceAt: string | null;
}

export interface SmokeTier2Entry {
  stage: string;
  jobId: string;
  status: SmokeVerifyStatus | 'PENDING';
  reason: string | null;
  queuedAt: string;
  /** The job's `finishedAt` — "PASS as of <checkedAt>". Null while PENDING. */
  checkedAt: string | null;
}

export interface SkillSmokeVerifyReport {
  projectId: string;
  generatedAt: string;
  tier1: SmokeTier1Entry[];
  /** Latest canary outcome per stage; empty until a tier-2 run is requested. */
  tier2: SmokeTier2Entry[];
}

// ── tier-1: static checks (pure core, DB-free) ──────────────────────────────

export interface StageRegistrationRow {
  stage: string;
  skillId: string;
  skillName: string;
  skillScope: 'global' | 'project';
}

const STAGE_ORDER = new Map<string, number>(PIPELINE_STEPS.map((s, i) => [s.status, i]));

/**
 * Compute the per-stage tier-1 entries from the registration rows + the
 * skill-major device sync status. Pure (no DB) so every branch is
 * unit-testable. `sync.skills` only contains usable project-scoped skills
 * (`resolveRegisteredEffectiveSkills`), so "registered name has no sync entry"
 * means the registration does not resolve to a usable project skill.
 */
export function computeTier1Entries(args: {
  registrations: StageRegistrationRow[];
  sync: ProjectSkillSyncStatus;
  now?: Date;
}): SmokeTier1Entry[] {
  const checkedAt = (args.now ?? new Date()).toISOString();
  const regByStage = new Map(args.registrations.map((r) => [r.stage, r]));
  const syncByName = new Map(args.sync.skills.map((s) => [s.name, s]));

  return PIPELINE_STEPS.map((step) => {
    const base = {
      stage: step.status,
      jobType: step.jobType,
      checkedAt,
      evidenceAt: null as string | null,
    };

    const reg = regByStage.get(step.status);
    if (!reg) {
      return {
        ...base,
        skillId: null,
        skillName: null,
        status: 'FAIL' as const,
        reason: 'not_registered' as const,
        detail: 'no skill is registered for this stage',
      };
    }

    const entry = syncByName.get(reg.skillName);
    if (!entry) {
      return {
        ...base,
        skillId: reg.skillId,
        skillName: reg.skillName,
        status: 'FAIL' as const,
        reason: 'no_project_skill' as const,
        detail: `registration points at '${reg.skillName}' but the project has no usable project-scoped skill of that name`,
      };
    }
    const ids = { skillId: entry.skillId, skillName: entry.name };

    if (args.sync.devices.length === 0) {
      return {
        ...base,
        ...ids,
        status: 'FAIL' as const,
        reason: 'no_bound_runner' as const,
        detail: 'no claude-code runner device is bound to this project',
      };
    }

    const synced = entry.devices.filter((d) => d.status === 'synced');
    if (synced.length > 0) {
      const evidenceAt =
        synced
          .map((d) => d.syncedAt)
          .filter((s): s is string => s != null)
          .sort()
          .pop() ?? null;
      return {
        ...base,
        ...ids,
        evidenceAt,
        status: 'PASS' as const,
        reason: null,
        detail: `installed hash matches the registry on ${synced.length}/${entry.devices.length} bound device(s)`,
      };
    }

    const reported = entry.devices.filter((d) => d.installedHash != null);
    if (reported.length > 0) {
      return {
        ...base,
        ...ids,
        status: 'FAIL' as const,
        reason: 'stale_on_runner' as const,
        detail: `installed hash differs from the registry on every reporting device (${reported.length}) — re-push via skill sync`,
      };
    }

    // Distinct from `stale_on_runner` on purpose: desktop devices report no
    // installedHash even when the install succeeded, so the honest verdict is
    // "no execution-grade evidence", not "missing" — and never a false green.
    return {
      ...base,
      ...ids,
      status: 'FAIL' as const,
      reason: 'no_device_report' as const,
      detail:
        'no bound device has ever reported an install for this skill — desktop runners do not report, so re-push via skill sync or run a tier-2 canary for execution evidence',
    };
  });
}

/** Load registrations + device sync status and compute the tier-1 entries. */
export async function loadSmokeVerifyTier1(projectId: string): Promise<SmokeTier1Entry[]> {
  const registrations = (await db
    .select({
      stage: skillRegistrations.stage,
      skillId: skillRegistrations.skillId,
      skillName: skills.name,
      skillScope: skills.scope,
    })
    .from(skillRegistrations)
    .innerJoin(skills, eq(skills.id, skillRegistrations.skillId))
    .where(eq(skillRegistrations.projectId, projectId))) as StageRegistrationRow[];

  const sync = await loadProjectSkillSyncStatus(projectId);
  return computeTier1Entries({ registrations, sync });
}

// ── tier-2: canary result capture (read-only over jobs rows) ────────────────

export interface SmokeJobRowLite {
  id: string;
  status: JobStatus;
  error: string | null;
  failureReason: string | null;
  payload: unknown;
  queuedAt: Date | string;
  finishedAt: Date | string | null;
}

function smokeStageOf(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const stage = (payload as Record<string, unknown>).smokeStage;
  return typeof stage === 'string' && stage.length > 0 ? stage : null;
}

function toIso(v: Date | string | null): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : v;
}

/**
 * Collapse smoke-job rows (newest first) into the latest canary outcome per
 * stage. Pure (no DB). PASS/FAIL is the job's TERMINAL status — written only
 * by the lifecycle chokepoint, never by this module — so the verdict is
 * execution evidence by construction.
 */
export function summarizeTier2Jobs(rows: SmokeJobRowLite[]): SmokeTier2Entry[] {
  const seen = new Set<string>();
  const out: SmokeTier2Entry[] = [];
  for (const row of rows) {
    const stage = smokeStageOf(row.payload);
    if (!stage || seen.has(stage)) continue;
    seen.add(stage);

    let status: SmokeTier2Entry['status'];
    let reason: string | null = null;
    if (row.status === 'done') {
      status = 'PASS';
    } else if (row.status === 'failed' || row.status === 'cancelled') {
      status = 'FAIL';
      reason = row.error ?? row.failureReason ?? `job ${row.status}`;
    } else {
      status = 'PENDING';
    }

    out.push({
      stage,
      jobId: row.id,
      status,
      reason,
      queuedAt: toIso(row.queuedAt) ?? new Date(0).toISOString(),
      checkedAt: toIso(row.finishedAt),
    });
  }
  // Stable pipeline-ladder order for the UI; unknown stages sort last.
  out.sort(
    (a, b) =>
      (STAGE_ORDER.get(a.stage) ?? Number.MAX_SAFE_INTEGER) -
      (STAGE_ORDER.get(b.stage) ?? Number.MAX_SAFE_INTEGER),
  );
  return out;
}

/** How many recent smoke jobs to scan for "latest per stage" (8 stages — a
 *  couple of full canary rounds of headroom). */
const TIER2_SCAN_LIMIT = 64;

export async function loadSmokeVerifyTier2(projectId: string): Promise<SmokeTier2Entry[]> {
  const rows = (await db
    .select({
      id: jobs.id,
      status: jobs.status,
      error: jobs.error,
      failureReason: jobs.failureReason,
      payload: jobs.payload,
      queuedAt: jobs.queuedAt,
      finishedAt: jobs.finishedAt,
    })
    .from(jobs)
    .where(and(eq(jobs.projectId, projectId), eq(jobs.type, 'smoke')))
    .orderBy(desc(jobs.queuedAt))
    .limit(TIER2_SCAN_LIMIT)) as SmokeJobRowLite[];

  return summarizeTier2Jobs(rows);
}

/** The full aggregated report — tier-1 always fresh, tier-2 = latest canaries. */
export async function buildSmokeVerifyReport(projectId: string): Promise<SkillSmokeVerifyReport> {
  const [tier1, tier2] = await Promise.all([
    loadSmokeVerifyTier1(projectId),
    loadSmokeVerifyTier2(projectId),
  ]);
  return { projectId, generatedAt: new Date().toISOString(), tier1, tier2 };
}

// ── tier-2: canary dispatch ─────────────────────────────────────────────────

export class NoRunnerOnlineError extends Error {
  readonly code = 'NO_RUNNER_ONLINE';
  constructor() {
    super('no runner is online for this project — canaries would queue forever');
    this.name = 'NoRunnerOnlineError';
  }
}

/**
 * The synthetic canary prompt. Deliberately NOT a `/<skill>` invocation — the
 * goal is to prove the skill is present + readable and that the
 * dispatch→runner→execution→terminal-capture path works, without starting the
 * stage's real work against a non-existent issue.
 */
export function buildSmokeCanaryPrompt(skillName: string, stage: string): string {
  return [
    '## Skill smoke-verify canary',
    '',
    `This is an automated SMOKE-VERIFY canary for the '${stage}' pipeline stage. There is NO real issue behind this job. Your only task is to prove the stage's skill is usable on this runner:`,
    '',
    `1. Locate the skill file at \`.claude/skills/${skillName}/SKILL.md\` under the repository root.`,
    '2. Read it and confirm the frontmatter parses (name + description present).',
    '3. Summarise in one short paragraph what the skill instructs, to prove it was readable.',
    '',
    'Hard rules:',
    '- Do NOT modify the repository: no file writes, no branches, no commits, no pushes.',
    '- Do NOT create or modify issues or comments, and do NOT call any forge_* write tools.',
    `- Do NOT start the actual '${stage}' stage work — this canary only verifies the skill loads.`,
    '',
    'End your reply with exactly one line:',
    `SMOKE_VERIFY_OK ${skillName}`,
    'if the skill file exists and is readable; otherwise end with:',
    `SMOKE_VERIFY_MISSING ${skillName}`,
  ].join('\n');
}

export interface CanaryDispatchResult {
  dispatched: Array<{ stage: string; jobId: string; skillName: string }>;
  skipped: Array<{ stage: string; reason: string }>;
}

export interface CanaryPlan {
  toDispatch: Array<{ stage: string; skillName: string }>;
  skipped: Array<{ stage: string; reason: string }>;
}

/**
 * Decide which stages get a canary. Pure (no DB) so the skip rules are
 * unit-testable: stages whose tier-1 registration checks fail have no skill to
 * canary; stages with a still-active canary are skipped to avoid pile-up
 * (issue-less jobs are not covered by the `jobs_active_unique` index).
 */
export function planSmokeCanaries(args: {
  tier1: SmokeTier1Entry[];
  activeStages: ReadonlySet<string>;
  stages?: string[] | undefined;
}): CanaryPlan {
  const want = args.stages && args.stages.length > 0 ? new Set(args.stages) : null;
  const plan: CanaryPlan = { toDispatch: [], skipped: [] };
  for (const entry of args.tier1) {
    if (want && !want.has(entry.stage)) continue;
    if (!entry.skillName) {
      plan.skipped.push({ stage: entry.stage, reason: entry.reason ?? 'not_registered' });
      continue;
    }
    if (args.activeStages.has(entry.stage)) {
      plan.skipped.push({ stage: entry.stage, reason: 'canary_already_active' });
      continue;
    }
    plan.toDispatch.push({ stage: entry.stage, skillName: entry.skillName });
  }
  return plan;
}

/**
 * Dispatch one `smoke` canary job per registered stage (optionally narrowed to
 * `stages`). Each canary rides the NORMAL pipeline machinery end to end:
 * one-shot `kind='system'` run (`openOneShotRun`) → `insertAndEnqueueJob` →
 * pg-boss → dispatcher (`selectRunnerForJob`) → runner → lifecycle routes.
 * Terminal status therefore flips only via `applyKernelTransition` (I2), and
 * the one-shot run auto-closes via `closeRunIfOneShot` when the job ends.
 * Skip rules live in `planSmokeCanaries`.
 */
export async function dispatchSmokeCanaries(args: {
  projectId: string;
  userId: string;
  stages?: string[] | undefined;
}): Promise<CanaryDispatchResult> {
  const { projectId, userId } = args;

  // Fail fast with an honest reason instead of parking jobs in `queued`.
  const runner = await selectRunnerForJob({ projectId, requiredCapabilities: {} });
  if (!runner) throw new NoRunnerOnlineError();

  const tier1 = await loadSmokeVerifyTier1(projectId);

  const activeRows = (await db
    .select({ payload: jobs.payload })
    .from(jobs)
    .where(
      and(
        eq(jobs.projectId, projectId),
        eq(jobs.type, 'smoke'),
        inArray(jobs.status, ['queued', 'dispatched', 'running']),
      ),
    )) as Array<{ payload: unknown }>;
  const activeStages = new Set(
    activeRows.map((r) => smokeStageOf(r.payload)).filter((s): s is string => s != null),
  );

  const plan = planSmokeCanaries({ tier1, activeStages, stages: args.stages });
  const result: CanaryDispatchResult = { dispatched: [], skipped: plan.skipped };

  for (const { stage, skillName } of plan.toDispatch) {
    const run = await openOneShotRun({
      projectId,
      kind: 'system',
      metadata: { source: 'skills.smoke-verify', smoke: true, stage, skillName },
    });

    const { jobId } = await insertAndEnqueueJob({
      projectId,
      issueId: null,
      pipelineRunId: run.id,
      createdBy: userId,
      type: 'smoke',
      skillName,
      promptString: buildSmokeCanaryPrompt(skillName, stage),
      payloadExtras: {
        smoke: true,
        smokeStage: stage,
        // Inherit the stage's per-state overrides (model/tools/timeout) so the
        // canary exercises the same dispatch shape as the real step.
        stageStatus: stage,
        // Bound the canary even when the stage has no timeout override.
        timeoutSeconds: 900,
      },
    });

    result.dispatched.push({ stage, jobId, skillName });
  }

  return result;
}
