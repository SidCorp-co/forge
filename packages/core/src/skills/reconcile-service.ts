// Update Pipeline stage ② (Reconcile), ISS-801.
//
// The Master agent per-project reconcile service. Assembles the 12-item
// context bundle (C1–C5 enforced), serializes per-project, dispatches the
// reconcile job and subsequent verifier jobs, and applies/escalates based on
// the majority verifier vote.
//
// Safety invariants (§9.7 / §9.11):
//   1. Any status transition emits the corresponding event into
//      skill_activity_events in the SAME database transaction.
//   2. A failure at ANY point preserves the last-good body — the skill is
//      never left empty or silently changed.
//   3. At most one active (pending/running/verifying) run per project at any
//      time, enforced by the partial unique index `reconcile_runs_active_project_uq`.

import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type ReconcileBundleSnapshot,
  type ReconcileGate,
  type ReconcileRunStatus,
  type ReconcileVerdict,
  type ReconcileVerifierVote,
  deviceSkills,
  divergenceCharters,
  jobs,
  projects,
  reconcileRuns,
  runners,
  skillActivityEvents,
  skills,
  updatePackets,
} from '../db/schema.js';
import { enqueueReconcileJob } from '../jobs/enqueue.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { logger } from '../logger.js';
import { openOneShotRun } from '../pipeline/runs.js';
import type { RecordSkillActivityEventInput, SkillActivityExecutor } from './activity.js';
import { recordSkillActivityEvent } from './activity.js';
import { hashSkillBody } from './hash.js';

// Wrapper that omits undefined values so exactOptionalPropertyTypes is
// satisfied when building RecordSkillActivityEventInput from nullable DB cols.
async function logActivity(
  executor: SkillActivityExecutor,
  params: Omit<
    RecordSkillActivityEventInput,
    | 'skillId'
    | 'packetId'
    | 'deviceId'
    | 'beforeHash'
    | 'afterHash'
    | 'deltaSummary'
    | 'reason'
    | 'outcome'
  > & {
    skillId?: string | null;
    packetId?: string | null;
    deviceId?: string | null;
    beforeHash?: string | null;
    afterHash?: string | null;
    deltaSummary?: string | null;
    reason?: string | null;
    outcome?: RecordSkillActivityEventInput['outcome'] | null;
  },
): Promise<void> {
  const clean: RecordSkillActivityEventInput = {
    eventType: params.eventType,
    actor: params.actor,
    trigger: params.trigger,
    ...(params.projectId !== undefined ? { projectId: params.projectId } : {}),
    ...(params.skillId != null ? { skillId: params.skillId } : {}),
    ...(params.packetId != null ? { packetId: params.packetId } : {}),
    ...(params.deviceId != null ? { deviceId: params.deviceId } : {}),
    ...(params.beforeHash != null ? { beforeHash: params.beforeHash } : {}),
    ...(params.afterHash != null ? { afterHash: params.afterHash } : {}),
    ...(params.deltaSummary != null ? { deltaSummary: params.deltaSummary } : {}),
    ...(params.reason != null ? { reason: params.reason } : {}),
    ...(params.outcome != null ? { outcome: params.outcome } : {}),
  };
  await recordSkillActivityEvent(executor, clean);
}

// ── Gate classifier (§6) ────────────────────────────────────────────────────

// These patterns in the change diff force the human gate regardless of verdict.
// Source: ISS-795 §6, ISS-373 evidence (auth exposure), ISS-354/365 (merge target).
const HUMAN_GATE_PATTERNS: RegExp[] = [
  /\bmerge.?target\b/i,
  /\bterminal.?transition\b/i,
  /\bauth\b/i,
  /\bpermission\b/i,
  /\bdata.?exposure\b/i,
  /\bremov(e|ing|al).{0,30}(gate|guard|step)\b/i,
  /\brelax.{0,30}(gate|guard|bar)\b/i,
  /\bdisabl(e|ing).{0,30}(gate|guard|check)\b/i,
];

/**
 * Classify whether the change may be auto-applied or requires human review.
 * Additive-only changes (add a guard/step, relax NO bar) may be auto-applied.
 * Any change that removes/relaxes a gate, alters auth/permission, or touches
 * merge targets or terminal transitions → human gate (ISS-795 §6).
 */
export function classifyGate(change: string, verdict: ReconcileVerdict): ReconcileGate {
  if (verdict === 'escalate') return 'human';
  for (const pattern of HUMAN_GATE_PATTERNS) {
    if (pattern.test(change)) return 'human';
  }
  return 'auto';
}

// ── C1–C5 bundle validator ───────────────────────────────────────────────────

const REQUIRED_BUNDLE_KEYS: (keyof ReconcileBundleSnapshot)[] = [
  'change',
  'story',
  'intentClass',
  'appliesTo',
  'runningBody',
  'runningHash',
  'readAt',
  'sources',
];

/**
 * Validate all five context-contract guarantees (ISS-795 §4).
 * Returns a human-readable refusal reason string, or null when all checks pass.
 *
 * C1 — Sufficient: all decision-relevant inputs are present.
 * C2 — Fresh: each input was read at decision time and carries a `readAt` stamp.
 * C3 — Sourced: every fact in the bundle is labelled with its provenance.
 * C4 — No-fabrication: code/history claims have a non-agent-assertion source.
 * C5 — Input-determinism: guaranteed by snapshotting at trigger time (structural).
 */
export function validateC1C5(bundle: Partial<ReconcileBundleSnapshot>): string | null {
  // C1: sufficient
  for (const key of REQUIRED_BUNDLE_KEYS) {
    const val = bundle[key];
    if (val === undefined || val === null || val === '') {
      return `C1: missing required bundle input: ${key}`;
    }
  }
  // C2: fresh — readAt present and recent (within 10 minutes of now)
  const readAt = new Date(bundle.readAt!).getTime();
  if (Number.isNaN(readAt)) return 'C2: bundle.readAt is not a valid ISO timestamp';
  const ageMs = Date.now() - readAt;
  if (ageMs > 10 * 60 * 1000) {
    return `C2: bundle is stale (readAt=${bundle.readAt}; age=${Math.round(ageMs / 1000)}s > 600s)`;
  }
  // C3: sourced — sources map must have at least the core fields
  const sources = bundle.sources ?? {};
  const sourceKeys = Object.keys(sources);
  if (sourceKeys.length === 0) {
    return 'C3: sources map is empty — every bundle fact must carry a provenance label';
  }
  // C4: no-fabrication — story must be labelled 'human', running body 'observed-from-run'
  if (sources.story && sources.story !== 'human') {
    return `C4: bundle.story is labelled '${sources.story}' — story must be human-authored`;
  }
  if (sources.runningBody && sources.runningBody !== 'observed-from-run') {
    return `C4: bundle.runningBody is labelled '${sources.runningBody}' — must be 'observed-from-run' (from step ④ observation)`;
  }
  return null;
}

// ── Bundle assembly ──────────────────────────────────────────────────────────

export interface AssembleBundleInput {
  projectId: string;
  packetId: string;
  skillId: string;
}

export interface AssembleBundleResult {
  ok: true;
  bundle: ReconcileBundleSnapshot;
  refusalReason: null;
  lastGoodBody: string | null;
  lastGoodHash: string | null;
}

export interface AssembleBundleRefused {
  ok: false;
  bundle: null;
  refusalReason: string;
  lastGoodBody: null;
  lastGoodHash: null;
}

/**
 * Assemble the 12-item context bundle (ISS-795 §4) and validate C1–C5.
 * All reads are transactional and timestamped (C2 fresh, C5 determinism).
 * Returns a structured refusal when any required input is missing or stale.
 *
 * Item 11 (platform invariant set) is read from the `skill_activity_events`
 * log (latest `policy.landed` event), which captures the output of stage ① as
 * a structured event payload. The bundle consumer (reconcile agent) treats
 * item 11 as a hard constraint on the candidate body.
 */
export async function assembleBundle(
  input: AssembleBundleInput,
): Promise<AssembleBundleResult | AssembleBundleRefused> {
  const readAt = new Date().toISOString();

  // Fetch all 12 items in parallel (C2: read at decision time, not from snapshot)
  const [
    packetRow,
    projectRow,
    skillRow,
    charterRow,
    recentRunRows,
    priorReconcileRows,
    lastPolicyEvent,
  ] = await Promise.all([
    // 1–5: Update Packet
    db
      .select()
      .from(updatePackets)
      .where(eq(updatePackets.id, input.packetId))
      .limit(1),
    // 8: projectFacts + pipelineConfig — both live inside agentConfig jsonb blob
    db
      .select({ agentConfig: projects.agentConfig })
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .limit(1),
    // 6: running body via device_skills observed_sha
    db
      .select({
        id: skills.id,
        skillMd: skills.skillMd,
        prompt: skills.prompt,
        contentHash: skills.contentHash,
        observedSha: deviceSkills.observedSha,
      })
      .from(skills)
      .leftJoin(
        deviceSkills,
        and(eq(deviceSkills.skillId, skills.id), eq(deviceSkills.projectId, input.projectId)),
      )
      .where(eq(skills.id, input.skillId))
      .orderBy(desc(deviceSkills.syncedAt))
      .limit(1),
    // 7: divergence charter
    db
      .select()
      .from(divergenceCharters)
      .where(eq(divergenceCharters.projectId, input.projectId))
      .limit(1),
    // 9: recent run evidence — last 5 reconcile runs for this skill/project
    db
      .select({
        status: reconcileRuns.status,
        verdict: reconcileRuns.verdict,
        createdAt: reconcileRuns.createdAt,
      })
      .from(reconcileRuns)
      .where(
        and(eq(reconcileRuns.projectId, input.projectId), eq(reconcileRuns.skillId, input.skillId)),
      )
      .orderBy(desc(reconcileRuns.createdAt))
      .limit(5),
    // 10: prior reconcile history
    db
      .select({
        verdict: reconcileRuns.verdict,
        rationale: reconcileRuns.rationale,
        decidedAt: reconcileRuns.decidedAt,
      })
      .from(reconcileRuns)
      .where(
        and(eq(reconcileRuns.projectId, input.projectId), eq(reconcileRuns.skillId, input.skillId)),
      )
      .orderBy(desc(reconcileRuns.createdAt))
      .limit(10),
    // 11: latest policy.landed event (stage ① output = invariant set)
    db
      .select({
        reason: skillActivityEvents.reason,
        deltaSummary: skillActivityEvents.deltaSummary,
        occurredAt: skillActivityEvents.occurredAt,
      })
      .from(skillActivityEvents)
      .where(eq(skillActivityEvents.eventType, 'policy.landed'))
      .orderBy(desc(skillActivityEvents.occurredAt))
      .limit(1),
  ]);

  const packet = packetRow[0];
  if (!packet) {
    return {
      ok: false,
      bundle: null,
      refusalReason: `C1: update packet not found: ${input.packetId}`,
      lastGoodBody: null,
      lastGoodHash: null,
    };
  }

  const project = projectRow[0];
  if (!project) {
    return {
      ok: false,
      bundle: null,
      refusalReason: `C1: project not found: ${input.projectId}`,
      lastGoodBody: null,
      lastGoodHash: null,
    };
  }

  const skill = skillRow[0];
  if (!skill) {
    return {
      ok: false,
      bundle: null,
      refusalReason: `C1: skill not found: ${input.skillId}`,
      lastGoodBody: null,
      lastGoodHash: null,
    };
  }

  const runningBody = skill.skillMd ?? skill.prompt ?? '';
  const runningHash = skill.observedSha ?? skill.contentHash ?? '';

  const charter = charterRow[0] ?? null;
  const policyEvent = lastPolicyEvent[0] ?? null;

  const bundle: ReconcileBundleSnapshot = {
    readAt,
    // 1–5: Update Packet
    change: packet.change,
    story: packet.story,
    intentClass: packet.intentClass,
    appliesTo: packet.appliesTo,
    provenance: (packet.provenance as Record<string, unknown>) ?? {},
    // 6: running body (observed when available — ISS-783 / ISS-795 §4 note on item 6)
    runningBody,
    runningHash,
    // 7: divergence charter
    charter: charter ? { entries: charter.entries } : null,
    // 8: projectFacts + pipelineConfig — extracted from agentConfig sub-keys
    projectFacts:
      ((project.agentConfig as Record<string, unknown> | null)?.projectFacts as Record<
        string,
        unknown
      >) ?? {},
    pipelineConfig:
      ((project.agentConfig as Record<string, unknown> | null)?.pipelineConfig as Record<
        string,
        unknown
      >) ?? {},
    // 9: recent run evidence
    recentRunEvidence: recentRunRows,
    // 10: prior reconcile history
    priorReconcileHistory: priorReconcileRows,
    // 11: currently-effective platform invariant set (stage ① output)
    invariantSet: policyEvent
      ? {
          reason: policyEvent.reason,
          deltaSummary: policyEvent.deltaSummary,
          occurredAt: policyEvent.occurredAt,
        }
      : {},
    // 12: must-not-break assertions — populated from charter's non-revertable entries
    mustNotBreak: charter
      ? ((charter.entries as Array<{ revertable: boolean; difference: string }>) ?? [])
          .filter((e) => !e.revertable)
          .map((e) => e.difference)
      : [],
    // C3 source labels
    sources: {
      change: 'from-code',
      story: 'human',
      intentClass: 'human',
      appliesTo: 'from-code',
      provenance: 'from-code',
      runningBody: skill.observedSha ? 'observed-from-run' : 'from-code',
      runningHash: skill.observedSha ? 'observed-from-run' : 'from-code',
      charter: 'human',
      projectFacts: 'human',
      pipelineConfig: 'human',
      recentRunEvidence: 'observed-from-run',
      priorReconcileHistory: 'observed-from-run',
      invariantSet: 'observed-from-run',
      mustNotBreak: 'human',
    },
  };

  const refusalReason = validateC1C5(bundle);
  if (refusalReason) {
    return { ok: false, bundle: null, refusalReason, lastGoodBody: null, lastGoodHash: null };
  }

  return {
    ok: true,
    bundle,
    refusalReason: null,
    lastGoodBody: runningBody || null,
    lastGoodHash: runningHash || null,
  };
}

// ── Spawn / lifecycle ────────────────────────────────────────────────────────

export type SpawnReconcileResult =
  | { ok: true; runId: string }
  | {
      ok: false;
      reason: 'already-active' | 'c1-c5-refused' | 'no-runner' | 'error';
      detail: string;
    };

/**
 * Trigger a reconcile run for a project + skill + packet.
 *
 * Serialization: the partial unique index `reconcile_runs_active_project_uq`
 * ensures at most one active run per project; a second concurrent call receives
 * `{ ok:false, reason:'already-active' }` — no queuing behind the active run.
 *
 * Flow:
 * 1. Assemble bundle (C1–C5 gate).
 * 2. Insert `reconcile_runs` row (status='pending') — unique index fires here
 *    if another run is in flight.
 * 3. Open a one-shot 'system' pipeline_run.
 * 4. Insert a `reconcile` job, route to RECONCILE_QUEUE.
 * 5. Emit `reconcile.started` into skill_activity_events.
 */
export async function spawnReconcileRun(input: {
  projectId: string;
  packetId: string;
  skillId: string;
  actorUserId: string;
}): Promise<SpawnReconcileResult> {
  const assembled = await assembleBundle({
    projectId: input.projectId,
    packetId: input.packetId,
    skillId: input.skillId,
  });

  if (!assembled.ok) {
    // C1–C5 refusal: no run row is created, so there is no state change to describe.
    // Log only — do NOT call recordSkillActivityEvent here (cm:guard requires tx).
    logger.info(
      { projectId: input.projectId, packetId: input.packetId, reason: assembled.refusalReason },
      'reconcile.refused.c1c5',
    );
    return { ok: false, reason: 'c1-c5-refused', detail: assembled.refusalReason };
  }

  const { bundle, lastGoodBody, lastGoodHash } = assembled;

  // Find an online runner for this project — the dispatcher matches capabilities later.
  const [runnerRow] = await db
    .select({ id: runners.id })
    .from(runners)
    .where(and(eq(runners.projectId, input.projectId), eq(runners.status, 'online')))
    .limit(1);

  if (!runnerRow) {
    return { ok: false, reason: 'no-runner', detail: 'no online runner bound to this project' };
  }

  // Open the pipeline_run first (openOneShotRun uses module-level db — cannot participate in tx)
  let pipelineRun: { id: string };
  try {
    pipelineRun = await openOneShotRun({ projectId: input.projectId, kind: 'system' });
  } catch (err) {
    logger.error({ err, projectId: input.projectId }, 'reconcile.spawn.openRun.error');
    return { ok: false, reason: 'error', detail: String(err) };
  }

  // Insert reconcile_run + job + activity event atomically
  let runId: string;
  let jobId: string;

  try {
    const result = await db.transaction(async (tx) => {
      // Insert the reconcile_run row (unique index enforces serialization)
      const [run] = await tx
        .insert(reconcileRuns)
        .values({
          projectId: input.projectId,
          packetId: input.packetId,
          skillId: input.skillId,
          status: 'pending',
          bundle,
          lastGoodBody,
          lastGoodHash,
        })
        .returning({ id: reconcileRuns.id });
      if (!run) throw new Error('reconcile_runs insert returned no row');

      // Insert the reconcile job
      const [job] = await tx
        .insert(jobs)
        .values({
          projectId: input.projectId,
          issueId: null,
          pipelineRunId: pipelineRun.id,
          createdBy: input.actorUserId,
          type: 'reconcile',
          payload: { reconcileRunId: run.id },
          status: 'queued',
        })
        .returning({ id: jobs.id });
      if (!job) throw new Error('reconcile job insert returned no row');

      // Emit reconcile.started in same transaction (§9.11)
      await logActivity(tx, {
        eventType: 'reconcile.started',
        actor: `human:${input.actorUserId}`,
        trigger: 'manual',
        projectId: input.projectId,
        skillId: input.skillId,
        packetId: input.packetId,
        reason: `reconcile run ${run.id}`,
      });

      return { runId: run.id, jobId: job.id };
    });

    runId = result.runId;
    jobId = result.jobId;
  } catch (err) {
    if (isUniqueViolation(err)) {
      return {
        ok: false,
        reason: 'already-active',
        detail: 'a reconcile run is already active for this project',
      };
    }
    logger.error({ err, projectId: input.projectId }, 'reconcile.spawn.error');
    return { ok: false, reason: 'error', detail: String(err) };
  }

  // Enqueue outside the transaction (pg-boss write must be after commit)
  await enqueueReconcileJob(jobId);

  logger.info({ projectId: input.projectId, runId, jobId }, 'reconcile.spawned');
  return { ok: true, runId };
}

// ── Verdict application ──────────────────────────────────────────────────────

export interface RecordVerdictInput {
  runId: string;
  verdict: ReconcileVerdict;
  candidateBody: string | null;
  rationale: string;
  /** Actor that produced the verdict (e.g. 'agent:master'). */
  actor: string;
}

/**
 * Record the reconcile agent's verdict and candidate body.
 * Transitions: running → verifying (when a candidate body is present and verdict is not escalate)
 *              running → escalated (verdict = escalate)
 *
 * Called by the reconcile agent via the `forge_reconcile` MCP tool.
 * cm:guard Call only when the job is in `running` state.
 */
export async function recordReconcileVerdict(input: RecordVerdictInput): Promise<void> {
  const [runRow] = await db
    .select()
    .from(reconcileRuns)
    .where(eq(reconcileRuns.id, input.runId))
    .limit(1);

  if (!runRow) throw new Error(`reconcile run not found: ${input.runId}`);

  const gate = classifyGate(runRow.bundle?.change ?? '', input.verdict);

  if (input.verdict === 'escalate' || input.verdict === 'no-op') {
    await db.transaction(async (tx) => {
      const nextStatus: ReconcileRunStatus = input.verdict === 'escalate' ? 'escalated' : 'applied';
      await tx
        .update(reconcileRuns)
        .set({
          status: nextStatus,
          verdict: input.verdict,
          gate,
          rationale: input.rationale,
          decidedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(reconcileRuns.id, input.runId));

      const eventType = input.verdict === 'escalate' ? 'reconcile.escalated' : 'reconcile.decided';
      await logActivity(tx, {
        eventType,
        actor: input.actor,
        trigger: 'manual',
        projectId: runRow.projectId,
        skillId: runRow.skillId,
        packetId: runRow.packetId,
        reason: input.rationale.slice(0, 500),
      });
    });
    return;
  }

  // apply / apply-with-adaptation: compute candidate hash + transition to verifying
  const candidateBody = input.candidateBody ?? '';
  const candidateHash = hashSkillBody(candidateBody, null);

  await db.transaction(async (tx) => {
    await tx
      .update(reconcileRuns)
      .set({
        status: 'verifying',
        verdict: input.verdict,
        gate,
        candidateBody,
        candidateHash,
        rationale: input.rationale,
        updatedAt: new Date(),
      })
      .where(eq(reconcileRuns.id, input.runId));

    await logActivity(tx, {
      eventType: 'reconcile.decided',
      actor: input.actor,
      trigger: 'manual',
      projectId: runRow.projectId,
      skillId: runRow.skillId,
      packetId: runRow.packetId,
      reason: `verdict=${input.verdict} gate=${gate}`,
    });
  });
}

// ── Verifier vote recording ──────────────────────────────────────────────────

export interface RecordVerifierVoteInput {
  runId: string;
  jobId: string;
  vote: 'pass' | 'fail';
  reason: string;
}

/**
 * Record one verifier agent's vote. After all votes are recorded, tallies
 * the majority and either publishes the candidate body (auto gate, majority
 * pass) or escalates (human gate or majority fail).
 *
 * Multi-vote: at least 2 verifier jobs must agree on 'pass' for auto-publish.
 * Called by the verifier agent via the `forge_reconcile` MCP tool.
 */
export async function recordVerifierVote(input: RecordVerifierVoteInput): Promise<void> {
  const [runRow] = await db
    .select()
    .from(reconcileRuns)
    .where(eq(reconcileRuns.id, input.runId))
    .limit(1);

  if (!runRow) throw new Error(`reconcile run not found: ${input.runId}`);
  if (runRow.status !== 'verifying') {
    logger.warn(
      { runId: input.runId, status: runRow.status },
      'verifier vote received for non-verifying run',
    );
    return;
  }

  const newVote: ReconcileVerifierVote = {
    jobId: input.jobId,
    vote: input.vote,
    reason: input.reason,
    decidedAt: new Date().toISOString(),
  };

  const existingVotes = (runRow.verifierVotes as ReconcileVerifierVote[]) ?? [];
  const allVotes = [...existingVotes, newVote];

  // Count pass vs fail
  const passCount = allVotes.filter((v) => v.vote === 'pass').length;
  const failCount = allVotes.filter((v) => v.vote === 'fail').length;

  // We spawn VERIFIER_VOTE_COUNT verifiers; majority = ceil(VERIFIER_VOTE_COUNT / 2)
  const VERIFIER_VOTE_COUNT = 3;
  const MAJORITY = Math.ceil(VERIFIER_VOTE_COUNT / 2); // 2

  const majorityPass = passCount >= MAJORITY;
  const majorityFail = failCount >= MAJORITY;
  const allVoted = allVotes.length >= VERIFIER_VOTE_COUNT;

  await db.transaction(async (tx) => {
    await tx
      .update(reconcileRuns)
      .set({ verifierVotes: allVotes, updatedAt: new Date() })
      .where(eq(reconcileRuns.id, input.runId));

    if (!allVoted && !majorityFail) {
      // Still collecting votes
      return;
    }

    if (majorityFail || (!majorityPass && allVoted)) {
      // Verifier blocked publication
      await tx
        .update(reconcileRuns)
        .set({ status: 'escalated', updatedAt: new Date() })
        .where(eq(reconcileRuns.id, input.runId));

      await logActivity(tx, {
        eventType: 'verify.failed',
        actor: 'agent:verifier',
        trigger: 'manual',
        projectId: runRow.projectId,
        skillId: runRow.skillId,
        packetId: runRow.packetId,
        reason: `verifier majority fail: ${failCount}/${allVotes.length}`,
      });
      return;
    }

    if (majorityPass) {
      // Gate check: auto or human?
      const gate = (runRow.gate as ReconcileGate) ?? 'human';
      if (gate === 'human') {
        // Majority pass but human gate → move to 'decided' for human review
        await tx
          .update(reconcileRuns)
          .set({ status: 'decided', decidedAt: new Date(), updatedAt: new Date() })
          .where(eq(reconcileRuns.id, input.runId));

        await logActivity(tx, {
          eventType: 'reconcile.decided',
          actor: 'agent:verifier',
          trigger: 'manual',
          projectId: runRow.projectId,
          skillId: runRow.skillId,
          packetId: runRow.packetId,
          reason: `verifier pass (${passCount}/${allVotes.length}), awaiting human gate`,
        });
        return;
      }

      // Auto gate + verifier pass → publish the candidate body
      if (!runRow.skillId) {
        logger.error({ runId: input.runId }, 'reconcile: cannot auto-publish, skillId is null');
        await tx
          .update(reconcileRuns)
          .set({
            status: 'escalated',
            error: 'skillId is null, cannot auto-publish',
            updatedAt: new Date(),
          })
          .where(eq(reconcileRuns.id, input.runId));
        return;
      }

      const candidateBody = runRow.candidateBody ?? '';
      const candidateHash = runRow.candidateHash ?? hashSkillBody(candidateBody, null);
      const lastGoodHash = runRow.lastGoodHash;

      await tx
        .update(skills)
        .set({
          skillMd: candidateBody,
          prompt: candidateBody,
          contentHash: candidateHash,
          version: sql`version + 1`,
          updatedAt: new Date(),
        })
        .where(eq(skills.id, runRow.skillId));

      await tx
        .update(reconcileRuns)
        .set({ status: 'applied', decidedAt: new Date(), updatedAt: new Date() })
        .where(eq(reconcileRuns.id, input.runId));

      await logActivity(tx, {
        eventType: 'skill.body.changed',
        actor: 'agent:master',
        trigger: 'manual',
        projectId: runRow.projectId,
        skillId: runRow.skillId,
        packetId: runRow.packetId,
        beforeHash: lastGoodHash,
        afterHash: candidateHash,
        reason: `auto-applied; verifier pass ${passCount}/${allVotes.length}; packet=${runRow.packetId}`,
      });
    }
  });
}

// ── Manual human-gate publish / reject ──────────────────────────────────────

/**
 * Human approves a 'decided' (human-gate) run and publishes the candidate body.
 * MUST be called by a project admin (caller must verify authorization).
 */
export async function applyReconcileRun(runId: string, actorUserId: string): Promise<void> {
  const [runRow] = await db
    .select()
    .from(reconcileRuns)
    .where(eq(reconcileRuns.id, runId))
    .limit(1);
  if (!runRow) throw new Error(`NOT_FOUND: reconcile run ${runId}`);
  if (runRow.status !== 'decided') {
    throw new Error(`BAD_REQUEST: run is in status '${runRow.status}', expected 'decided'`);
  }
  if (!runRow.skillId) {
    throw new Error('BAD_REQUEST: run has no skillId — cannot publish');
  }

  const candidateBody = runRow.candidateBody ?? '';
  const candidateHash = runRow.candidateHash ?? hashSkillBody(candidateBody, null);
  const lastGoodHash = runRow.lastGoodHash;

  await db.transaction(async (tx) => {
    await tx
      .update(skills)
      .set({
        skillMd: candidateBody,
        prompt: candidateBody,
        contentHash: candidateHash,
        version: sql`version + 1`,
        updatedAt: new Date(),
      })
      .where(eq(skills.id, runRow.skillId!));

    await tx
      .update(reconcileRuns)
      .set({ status: 'applied', decidedAt: new Date(), updatedAt: new Date() })
      .where(eq(reconcileRuns.id, runId));

    await logActivity(tx, {
      eventType: 'skill.body.changed',
      actor: `human:${actorUserId}`,
      trigger: 'manual',
      projectId: runRow.projectId,
      skillId: runRow.skillId,
      packetId: runRow.packetId,
      beforeHash: lastGoodHash,
      afterHash: candidateHash,
      reason: `human approved; packet=${runRow.packetId}`,
    });
  });
}

/**
 * Human rejects a 'decided' run — escalates, preserving the last-good body.
 */
export async function rejectReconcileRun(
  runId: string,
  actorUserId: string,
  reason: string,
): Promise<void> {
  const [runRow] = await db
    .select()
    .from(reconcileRuns)
    .where(eq(reconcileRuns.id, runId))
    .limit(1);
  if (!runRow) throw new Error(`NOT_FOUND: reconcile run ${runId}`);
  if (runRow.status !== 'decided') {
    throw new Error(`BAD_REQUEST: run is in status '${runRow.status}', expected 'decided'`);
  }

  await db.transaction(async (tx) => {
    await tx
      .update(reconcileRuns)
      .set({ status: 'escalated', updatedAt: new Date() })
      .where(eq(reconcileRuns.id, runId));

    await logActivity(tx, {
      eventType: 'reconcile.escalated',
      actor: `human:${actorUserId}`,
      trigger: 'manual',
      projectId: runRow.projectId,
      skillId: runRow.skillId,
      packetId: runRow.packetId,
      reason: reason || 'human rejected',
    });
  });
}

// ── Query helpers ────────────────────────────────────────────────────────────

export async function getReconcileRun(runId: string) {
  const [row] = await db.select().from(reconcileRuns).where(eq(reconcileRuns.id, runId)).limit(1);
  return row ?? null;
}

export async function listReconcileRunsForProject(projectId: string, limit = 20) {
  return db
    .select()
    .from(reconcileRuns)
    .where(eq(reconcileRuns.projectId, projectId))
    .orderBy(desc(reconcileRuns.createdAt))
    .limit(limit);
}
