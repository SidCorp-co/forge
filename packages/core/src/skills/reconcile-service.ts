// Update Pipeline stage ② (Reconcile), ISS-801.
//
// The Master agent per-project reconcile service. Assembles the
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

import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
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
  organizationMembers,
  projectMembers,
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
import { resolveNotifications } from '../notifications/auto-resolve.js';
import { emitNotification } from '../notifications/emit.js';
import { closeRun, openOneShotRun } from '../pipeline/runs.js';
import type { RecordSkillActivityEventInput, SkillActivityExecutor } from './activity.js';
import { recordSkillActivityEvent } from './activity.js';
import { globalEffectiveMd } from './effective.js';
import { hashSkillBody } from './hash.js';
import { ensurePolicyLandedFor } from './policy-landed.js';

// cm:why omits undefined keys — exactOptionalPropertyTypes rejects `{ x: undefined }`, so nullable DB columns must be filtered before forwarding to RecordSkillActivityEventInput.
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

// cm:why mirrors effectiveProjectRole's admin rule (lib/authz.ts) — explicit project_members admin UNION org owner/admin — so the gate notification reaches exactly the people who can act on it via apply/reject/acknowledge.
async function projectAdminUserIds(projectId: string): Promise<string[]> {
  const [project] = await db
    .select({ orgId: projects.orgId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return [];

  const [explicitAdmins, orgAdmins] = await Promise.all([
    db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.role, 'admin'))),
    db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, project.orgId),
          inArray(organizationMembers.role, ['owner', 'admin']),
        ),
      ),
  ]);

  return [...new Set([...explicitAdmins.map((r) => r.userId), ...orgAdmins.map((r) => r.userId)])];
}

/**
 * Fan out a `reconcile_gate_pending` notification to every effective project
 * admin. Call AFTER the transaction that produced the transition commits —
 * see the `notify` result field on `recordReconcileVerdict`/`recordVerifierVote`.
 */
async function notifyGatePending(
  runId: string,
  projectId: string,
  kind: 'decided' | 'escalated',
): Promise<void> {
  const [project] = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const projectName = project?.name ?? 'this project';
  const adminIds = await projectAdminUserIds(projectId);

  const title =
    kind === 'decided'
      ? `Skill update needs your review — ${projectName}`
      : `Skill update escalated — ${projectName}`;
  const body =
    kind === 'decided'
      ? `A skill update passed verification and is waiting for your decision in ${projectName}.`
      : `A skill update was escalated for your review in ${projectName}.`;

  await Promise.all(
    adminIds.map((userId) =>
      emitNotification({
        userId,
        projectId,
        type: 'reconcile_gate_pending',
        title,
        body,
        resolutionKey: `reconcile_run:${runId}:gate`,
      }),
    ),
  );
}

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
  for (const key of REQUIRED_BUNDLE_KEYS) {
    const val = bundle[key];
    if (val === undefined || val === null || val === '') {
      return `C1: missing required bundle input: ${key}`;
    }
  }
  const readAt = new Date(bundle.readAt!).getTime();
  if (Number.isNaN(readAt)) return 'C2: bundle.readAt is not a valid ISO timestamp';
  const ageMs = Date.now() - readAt;
  if (ageMs > 10 * 60 * 1000) {
    return `C2: bundle is stale (readAt=${bundle.readAt}; age=${Math.round(ageMs / 1000)}s > 600s)`;
  }
  const sources = bundle.sources ?? {};
  const sourceKeys = Object.keys(sources);
  if (sourceKeys.length === 0) {
    return 'C3: sources map is empty — every bundle fact must carry a provenance label';
  }
  if (sources.story && sources.story !== 'human') {
    return `C4: bundle.story is labelled '${sources.story}' — story must be human-authored`;
  }
  if (sources.runningBody && sources.runningBody !== 'observed-from-run') {
    return `C4: bundle.runningBody is labelled '${sources.runningBody}' — must be 'observed-from-run' (from step ④ observation)`;
  }
  return null;
}

/**
 * Whether the stored body is provably the one running on every device that has
 * reported. Pure — no DB access — so the rule is unit-testable in isolation.
 */
// cm:guard `observed-from-run` may only be claimed when the STORED body IS what runs — Forge keeps no content-addressed copy of an observed body, so a mismatch cannot be resolved by fetching the real bytes; the only honest move is to stop claiming observation and let C4 refuse
// cm:why the label used to depend on merely HAVING an observedSha, so a stale or shadowed device still yielded a bundle labelled `observed-from-run` while handing the agent the server's copy — C4 exists to stop exactly that, and was passing on it
export function isRunningBodyObserved(
  storedHash: string | null,
  observations: ReadonlyArray<{ observedSha: string | null; shadowedBy: string | null }>,
): boolean {
  if (!storedHash) return false;
  const reported = observations.filter((d) => d.observedSha != null);
  return (
    reported.length > 0 &&
    reported.every((d) => d.shadowedBy == null && d.observedSha === storedHash)
  );
}

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
 * Assemble the context bundle (ISS-795 §4) and validate C1–C5.
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

  // cm:why fetched at call time (not from a stored snapshot) to satisfy C2 freshness.
  const [
    packetRow,
    projectRow,
    skillRow,
    deviceObservations,
    charterRow,
    recentRunRows,
    priorReconcileRows,
    lastPolicyEvent,
  ] = await Promise.all([
    db.select().from(updatePackets).where(eq(updatePackets.id, input.packetId)).limit(1),
    db
      .select({ agentConfig: projects.agentConfig })
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .limit(1),
    db
      .select({
        id: skills.id,
        skillMd: skills.skillMd,
        prompt: skills.prompt,
        contentHash: skills.contentHash,
      })
      .from(skills)
      .where(eq(skills.id, input.skillId))
      .limit(1),
    db
      .select({ observedSha: deviceSkills.observedSha, shadowedBy: deviceSkills.shadowedBy })
      .from(deviceSkills)
      .where(
        and(eq(deviceSkills.skillId, input.skillId), eq(deviceSkills.projectId, input.projectId)),
      ),
    db
      .select()
      .from(divergenceCharters)
      .where(eq(divergenceCharters.projectId, input.projectId))
      .limit(1),
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
    // cm:guard scoped to this project — an unscoped policy.landed read would leak another project's reason/deltaSummary into this bundle (MINOR K, ISS-801 review).
    db
      .select({
        reason: skillActivityEvents.reason,
        deltaSummary: skillActivityEvents.deltaSummary,
        occurredAt: skillActivityEvents.occurredAt,
      })
      .from(skillActivityEvents)
      .where(
        and(
          eq(skillActivityEvents.eventType, 'policy.landed'),
          eq(skillActivityEvents.projectId, input.projectId),
        ),
      )
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

  const runningIsObserved = isRunningBodyObserved(skill.contentHash, deviceObservations);
  const runningHash = skill.contentHash ?? '';

  const charter = charterRow[0] ?? null;
  const policyEvent = lastPolicyEvent[0] ?? null;

  const bundle: ReconcileBundleSnapshot = {
    readAt,
    change: packet.change,
    story: packet.story,
    intentClass: packet.intentClass,
    appliesTo: packet.appliesTo,
    provenance: (packet.provenance as Record<string, unknown>) ?? {},
    runningBody,
    runningHash,
    charter: charter ? { entries: charter.entries } : null,
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
    recentRunEvidence: recentRunRows,
    priorReconcileHistory: priorReconcileRows,
    invariantSet: policyEvent
      ? {
          reason: policyEvent.reason,
          deltaSummary: policyEvent.deltaSummary,
          occurredAt: policyEvent.occurredAt,
        }
      : {},
    mustNotBreak: charter
      ? ((charter.entries as Array<{ revertable: boolean; difference: string }>) ?? [])
          .filter((e) => !e.revertable)
          .map((e) => e.difference)
      : [],
    sources: {
      change: 'from-code',
      story: 'human',
      intentClass: 'human',
      appliesTo: 'from-code',
      provenance: 'from-code',
      runningBody: runningIsObserved ? 'observed-from-run' : 'from-code',
      runningHash: runningIsObserved ? 'observed-from-run' : 'from-code',
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

// cm:guard serve these two agents' instructions from the global skill row, NEVER from the device's disk — Forge alone owns the agent that governs every project's updates, so no project may adopt, edit or fork it (owner decision 2026-08-10)
// cm:why the disk-path form forced adoption + install_only fan-out, which handed each project an editable copy of its own governor and made the run depend on the sync path that already fails in the wild (device.sync.failed 502, portal-lighthuman 2026-08-09)
async function loadAgentInstructions(name: string): Promise<string> {
  const [row] = await db
    .select({ skillMd: skills.skillMd, prompt: skills.prompt })
    .from(skills)
    .where(and(eq(skills.name, name), eq(skills.scope, 'global')))
    .limit(1);
  const body = row ? globalEffectiveMd(row) : '';
  if (!body) {
    throw new Error(`reconcile: global agent skill '${name}' is missing — cannot build its prompt`);
  }
  return body;
}

function withAgentInstructions(header: string[], instructions: string): string {
  return [
    ...header,
    '',
    'Your full instructions for this stage follow. Do not look for them on disk — this is the authoritative copy.',
    '',
    '---',
    '',
    instructions,
  ].join('\n');
}

function buildReconcilePrompt(runId: string, instructions: string): string {
  return withAgentInstructions(
    [
      '## Update Pipeline — Reconcile (Master agent)',
      '',
      `runId: ${runId}`,
      '',
      `Start by calling \`forge_reconcile action=get\` with runId=${runId} to load the bundle for this run.`,
      'You MUST call `forge_reconcile action=record_verdict` before this job ends — leaving the run without a verdict permanently stalls it.',
    ],
    instructions,
  );
}

export function buildVerifierPromptWith(
  runId: string,
  jobId: string,
  instructions: string,
): string {
  return withAgentInstructions(
    [
      '## Update Pipeline — Verify Skill (adversarial verifier)',
      '',
      `runId: ${runId}`,
      `jobId: ${jobId}`,
      `Start by calling \`forge_reconcile action=get\` with runId=${runId} to load the run for this verification.`,
      `When you record your vote, pass jobId=${jobId} — this is YOUR job's own ID, not the Master agent's.`,
      'You MUST call `forge_reconcile action=record_vote` before this job ends — leaving your vote unrecorded permanently stalls the run.',
    ],
    instructions,
  );
}

// cm:edge naming -> packages/core/src/jobs/retry.ts — exported so a verify_skill retry clone can rebuild promptString with ITS OWN job id instead of reusing the dead original's (MINOR V, ISS-801 review round 4).
export async function buildVerifierPrompt(runId: string, jobId: string): Promise<string> {
  return buildVerifierPromptWith(runId, jobId, await loadAgentInstructions('forge-verify-skill'));
}

// cm:why must equal the number of verify_skill jobs spawnVerifierJobs dispatches — recordVerifierVote's majority tally never resolves if fewer jobs exist than it waits for.
const VERIFIER_VOTE_COUNT = 3;

// cm:why bounds the retryOf walk below; independent of jobs/retry.ts's RETRY_MAX_ROUNDS (importing
// it would cycle retry.ts -> reconcile-service.ts -> retry.ts) but serves the same purpose.
const MAX_RETRY_CHAIN_DEPTH = 10;

/**
 * Walks a verify_skill job's `retryOf` chain (this job, its parent, grandparent, ...)
 * so a vote from a retry clone can supersede its dead ancestor's vote instead of
 * being tallied as a second, independent verifier (MINOR AC, ISS-801 review round 5).
 */
async function resolveRetryChainIds(
  tx: Pick<typeof db, 'select'>,
  jobId: string,
): Promise<Set<string>> {
  const chain = new Set<string>([jobId]);
  let current = jobId;
  for (let hop = 0; hop < MAX_RETRY_CHAIN_DEPTH; hop++) {
    const [row] = await tx
      .select({ retryOf: jobs.retryOf })
      .from(jobs)
      .where(eq(jobs.id, current))
      .limit(1);
    if (!row?.retryOf || chain.has(row.retryOf)) break;
    chain.add(row.retryOf);
    current = row.retryOf;
  }
  return chain;
}

/**
 * Shared terminal-fail transition for an active `reconcile_runs` row (BLOCKER M,
 * ISS-801 review). No-op when the run is not found or has already left the
 * active set (pending/running/verifying) — a verdict/vote/apply/reject that
 * already landed always wins over a late terminal-path call.
 */
async function failActiveReconcileRun(runId: string, reason: string): Promise<void> {
  await db.transaction(async (tx) => {
    // cm:why FOR UPDATE row-locks this run, so a concurrent verdict/vote write cannot race the fail-transition below.
    const [runRow] = await tx
      .select()
      .from(reconcileRuns)
      .where(eq(reconcileRuns.id, runId))
      .for('update')
      .limit(1);
    if (!runRow) return;
    if (!['pending', 'running', 'verifying'].includes(runRow.status)) return;

    await tx
      .update(reconcileRuns)
      .set({ status: 'failed', error: reason.slice(0, 500), updatedAt: new Date() })
      .where(
        and(
          eq(reconcileRuns.id, runId),
          inArray(reconcileRuns.status, ['pending', 'running', 'verifying']),
        ),
      );

    await logActivity(tx, {
      eventType: 'reconcile.failed',
      actor: 'system:dispatcher',
      trigger: 'manual',
      projectId: runRow.projectId,
      skillId: runRow.skillId,
      packetId: runRow.packetId,
      reason: reason.slice(0, 500),
    });
  });
}

/**
 * Dispatch VERIFIER_VOTE_COUNT independent `verify_skill` jobs for a run that
 * just transitioned to 'verifying' (BLOCKER M path 1, ISS-801 review).
 * Without this, no job is ever created to vote — `recordVerifierVote`
 * correctly rejects any jobId with no matching dispatched `verify_skill` row,
 * so 'verifying' was terminal in practice. Any dispatch failure fails the
 * whole run rather than stranding it on an unreachable majority.
 */
async function spawnVerifierJobs(runId: string, projectId: string): Promise<void> {
  const [runnerRow] = await db
    .select({ id: runners.id })
    .from(runners)
    .where(and(eq(runners.projectId, projectId), eq(runners.status, 'online')))
    .limit(1);
  if (!runnerRow) {
    logger.error({ runId, projectId }, 'reconcile.verify.noRunner');
    await failActiveReconcileRun(
      runId,
      'no online runner bound to this project — cannot dispatch verifiers',
    );
    return;
  }

  // cm:why projects.createdBy is a valid FK stand-in for a system-initiated dispatch —
  // same convention as finalize-failure.ts's reconcileIssueStatusAfterFailure.
  const [projectRow] = await db
    .select({ createdBy: projects.createdBy })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!projectRow) {
    await failActiveReconcileRun(runId, `project not found: ${projectId}`);
    return;
  }

  // cm:why loaded once for all VERIFIER_VOTE_COUNT verifiers — the body is identical per run, so doing it inside the loop was three byte-identical selects of a multi-KB TOASTed column.
  const verifierInstructions = await loadAgentInstructions('forge-verify-skill');

  // cm:guard each verifier needs its OWN one-shot 'system' pipeline_run — closeRunIfOneShot (pipeline/runs.ts) cascade-cancels every still-active sibling job on a shared run the instant any one job on it goes terminal.
  const openedRunIds: string[] = [];
  const jobIds: string[] = [];
  for (let i = 0; i < VERIFIER_VOTE_COUNT; i++) {
    let pipelineRun: { id: string };
    try {
      pipelineRun = await openOneShotRun({ projectId, kind: 'system' });
    } catch (err) {
      logger.error({ err, runId, projectId, i }, 'reconcile.verify.openRun.error');
      await Promise.all(
        openedRunIds.map((id) =>
          closeRun(id, 'failed').catch((closeErr) =>
            logger.error({ closeErr, runId: id }, 'reconcile.verify.closeOrphanedRun.error'),
          ),
        ),
      );
      await failActiveReconcileRun(runId, `failed to open verifier pipeline run: ${String(err)}`);
      return;
    }
    openedRunIds.push(pipelineRun.id);

    const jobId = randomUUID();
    try {
      await db.insert(jobs).values({
        id: jobId,
        projectId,
        issueId: null,
        pipelineRunId: pipelineRun.id,
        createdBy: projectRow.createdBy,
        type: 'verify_skill',
        payload: {
          reconcileRunId: runId,
          skillName: 'forge-verify-skill',
          promptString: buildVerifierPromptWith(runId, jobId, verifierInstructions),
        },
        status: 'queued',
      });
      await enqueueReconcileJob(jobId);
    } catch (err) {
      logger.error({ err, runId, projectId, i }, 'reconcile.verify.dispatch.error');
      await Promise.all(
        openedRunIds.map((id) =>
          closeRun(id, 'failed').catch((closeErr) =>
            logger.error({ closeErr, runId: id }, 'reconcile.verify.closeOrphanedRun.error'),
          ),
        ),
      );
      await failActiveReconcileRun(runId, `failed to dispatch verifier job: ${String(err)}`);
      return;
    }
    jobIds.push(jobId);
  }

  logger.info({ runId, projectId, jobIds }, 'reconcile.verify.spawned');
}

export type SpawnReconcileResult =
  | { ok: true; runId: string }
  | {
      ok: false;
      reason: 'already-active' | 'c1-c5-refused' | 'no-runner' | 'pinned' | 'error';
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
  // cm:guard refuse a `pinned` skill BEFORE assembling a bundle or opening a run — no reconcile may ever rewrite a deliberately divergent body (ISS-795 §9.6)
  // cm:why anhome's forge-release dropped the production merge after 148484a0 broke prod for 10 days; an agent "helpfully" restoring it would recreate that outage
  const [pinnedRow] = await db
    .select({ pinned: skills.pinned, pinnedReason: skills.pinnedReason })
    .from(skills)
    .where(eq(skills.id, input.skillId))
    .limit(1);
  // cm:guard skill_activity_events.skill_id FKs to skills(id) — only forward input.skillId to logActivity below when this query proved the row exists, else the insert 23503s (ISS-801 review BLOCKER AD).
  const skillRowExists = pinnedRow !== undefined;

  if (pinnedRow?.pinned) {
    const detail = pinnedRow.pinnedReason
      ? `skill is pinned: ${pinnedRow.pinnedReason}`
      : 'skill is pinned (intentional divergence)';
    logger.info(
      { projectId: input.projectId, skillId: input.skillId, packetId: input.packetId },
      'reconcile.refused.pinned',
    );
    await logActivity(db, {
      eventType: 'reconcile.failed',
      actor: `human:${input.actorUserId}`,
      trigger: 'manual',
      projectId: input.projectId,
      skillId: input.skillId,
      packetId: input.packetId,
      reason: detail,
      outcome: 'skipped',
    });
    return { ok: false, reason: 'pinned', detail };
  }

  // cm:why self-heal before assembling — the boot sweep only sees projects that existed at boot,
  // so a project created since would otherwise carry an empty bundle item 11 (ISS-795 stage ①)
  await ensurePolicyLandedFor(input.projectId).catch((err) =>
    logger.warn({ err, projectId: input.projectId }, 'reconcile.policyLanded.ensure.failed'),
  );

  const assembled = await assembleBundle({
    projectId: input.projectId,
    packetId: input.packetId,
    skillId: input.skillId,
  });

  if (!assembled.ok) {
    logger.info(
      { projectId: input.projectId, packetId: input.packetId, reason: assembled.refusalReason },
      'reconcile.refused.c1c5',
    );
    await logActivity(db, {
      eventType: 'reconcile.failed',
      actor: `human:${input.actorUserId}`,
      trigger: 'manual',
      projectId: input.projectId,
      skillId: skillRowExists ? input.skillId : null,
      packetId: input.packetId,
      reason: assembled.refusalReason,
      outcome: 'skipped',
    });
    return { ok: false, reason: 'c1-c5-refused', detail: assembled.refusalReason };
  }

  const { bundle, lastGoodBody, lastGoodHash } = assembled;

  const [runnerRow] = await db
    .select({ id: runners.id })
    .from(runners)
    .where(and(eq(runners.projectId, input.projectId), eq(runners.status, 'online')))
    .limit(1);

  if (!runnerRow) {
    await logActivity(db, {
      eventType: 'reconcile.failed',
      actor: `human:${input.actorUserId}`,
      trigger: 'manual',
      projectId: input.projectId,
      skillId: input.skillId,
      packetId: input.packetId,
      reason: 'no online runner bound to this project',
      outcome: 'skipped',
    });
    return { ok: false, reason: 'no-runner', detail: 'no online runner bound to this project' };
  }

  // cm:why opened before the tx below — openOneShotRun uses module-level db and cannot join a transaction.
  let pipelineRun: { id: string };
  try {
    pipelineRun = await openOneShotRun({ projectId: input.projectId, kind: 'system' });
  } catch (err) {
    logger.error({ err, projectId: input.projectId }, 'reconcile.spawn.openRun.error');
    return { ok: false, reason: 'error', detail: String(err) };
  }

  let runId: string;
  let jobId: string;

  // cm:guard load the agent body BEFORE opening the transaction — querying the module-level `db` inside `db.transaction` borrows a SECOND pool connection while the write tx holds the first, and stretches the tx by a full round trip.
  const reconcileInstructions = await loadAgentInstructions('forge-reconcile');

  try {
    const result = await db.transaction(async (tx) => {
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

      const [job] = await tx
        .insert(jobs)
        .values({
          projectId: input.projectId,
          issueId: null,
          pipelineRunId: pipelineRun.id,
          createdBy: input.actorUserId,
          type: 'reconcile',
          payload: {
            reconcileRunId: run.id,
            skillName: 'forge-reconcile',
            promptString: buildReconcilePrompt(run.id, reconcileInstructions),
          },
          status: 'queued',
        })
        .returning({ id: jobs.id });
      if (!job) throw new Error('reconcile job insert returned no row');

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
    await closeRun(pipelineRun.id, 'failed').catch((closeErr) =>
      logger.error({ closeErr, runId: pipelineRun.id }, 'reconcile.spawn.closeOrphanedRun.error'),
    );
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

  // cm:why pg-boss send() must happen after commit — enqueueing inside the tx above risks a job
  // message for a run the tx then rolls back.
  try {
    await enqueueReconcileJob(jobId);
  } catch (err) {
    // cm:guard a send() failure here must not strand reconcile_runs at 'pending' forever — nothing
    // else can terminate it, and reconcile_runs_active_project_uq would then block every future run.
    logger.error(
      { err, projectId: input.projectId, runId, jobId },
      'reconcile.spawn.enqueue.error',
    );
    await db
      .transaction(async (tx) => {
        await tx
          .update(reconcileRuns)
          .set({ status: 'failed', error: String(err), updatedAt: new Date() })
          .where(and(eq(reconcileRuns.id, runId), eq(reconcileRuns.status, 'pending')));
        await logActivity(tx, {
          eventType: 'reconcile.failed',
          actor: 'system:dispatcher',
          trigger: 'manual',
          projectId: input.projectId,
          skillId: input.skillId,
          packetId: input.packetId,
          reason: `enqueue failed: ${String(err)}`.slice(0, 500),
        });
      })
      .catch((txErr) =>
        logger.error({ txErr, runId, jobId }, 'reconcile.spawn.enqueue.containment.error'),
      );
    // cm:why closeRun cascades the still-queued job to 'cancelled' via cascadeCancelChildJobs.
    await closeRun(pipelineRun.id, 'failed').catch((closeErr) =>
      logger.error({ closeErr, runId: pipelineRun.id }, 'reconcile.spawn.closeOrphanedRun.error'),
    );
    return { ok: false, reason: 'error', detail: `enqueue failed: ${String(err)}` };
  }

  logger.info({ projectId: input.projectId, runId, jobId }, 'reconcile.spawned');
  return { ok: true, runId };
}

export interface RecordVerdictInput {
  runId: string;
  verdict: ReconcileVerdict;
  candidateBody: string | null;
  rationale: string;
  // cm:guard the gate is DECLARED by the reconcile agent and re-judged adversarially by the verifiers — no server-side rule may override or second-guess it, including for `escalate` (owner decision 2026-08-10)
  /**
   * Which gate this change must clear, as judged by the reconcile agent — the
   * only party that has read the actual diff between running and candidate body.
   */
  gate: ReconcileGate;
  /** Actor that produced the verdict (e.g. 'agent:master'). */
  actor: string;
}

interface VerdictTxResult {
  toVerifying: boolean;
  projectId: string;
  /** Set only when this call is the one that transitioned the run to `escalated`/`verdict=escalate`. */
  notify: 'escalated' | null;
}

/**
 * Record the reconcile agent's verdict and candidate body.
 * Transitions: pending|running → verifying (candidate body present, verdict not escalate)
 *              pending|running → escalated (verdict = escalate)
 *
 * Called by the reconcile agent via the `forge_reconcile` MCP tool.
 */
// cm:guard call only when the run is 'pending' or 'running' — nothing else ever writes 'running',
// so 'pending' must stay a valid pre-verdict status here (BLOCKER F, ISS-801 review).
export async function recordReconcileVerdict(input: RecordVerdictInput): Promise<void> {
  const result = await db.transaction(async (tx): Promise<VerdictTxResult> => {
    // cm:why FOR UPDATE row-locks this run, serializing concurrent verdict calls.
    const [runRow] = await tx
      .select()
      .from(reconcileRuns)
      .where(eq(reconcileRuns.id, input.runId))
      .for('update')
      .limit(1);

    if (!runRow) throw new Error(`reconcile run not found: ${input.runId}`);
    if (runRow.status !== 'pending' && runRow.status !== 'running') {
      logger.warn(
        { runId: input.runId, status: runRow.status },
        'recordReconcileVerdict called for a run not pending/running — skipping',
      );
      return { toVerifying: false, projectId: runRow.projectId, notify: null };
    }

    const gate = input.gate;

    if (input.verdict === 'escalate' || input.verdict === 'no-op') {
      const nextStatus: ReconcileRunStatus = input.verdict === 'escalate' ? 'escalated' : 'applied';
      const updated = await tx
        .update(reconcileRuns)
        .set({
          status: nextStatus,
          verdict: input.verdict,
          gate,
          rationale: input.rationale,
          decidedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(reconcileRuns.id, input.runId),
            inArray(reconcileRuns.status, ['pending', 'running']),
          ),
        )
        .returning({ id: reconcileRuns.id });

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
      return {
        toVerifying: false,
        projectId: runRow.projectId,
        notify: input.verdict === 'escalate' && updated.length > 0 ? 'escalated' : null,
      };
    }

    const candidateBody = input.candidateBody ?? '';
    const candidateHash = hashSkillBody(candidateBody, null);

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
      .where(
        and(
          eq(reconcileRuns.id, input.runId),
          inArray(reconcileRuns.status, ['pending', 'running']),
        ),
      );

    await logActivity(tx, {
      eventType: 'reconcile.decided',
      actor: input.actor,
      trigger: 'manual',
      projectId: runRow.projectId,
      skillId: runRow.skillId,
      packetId: runRow.packetId,
      reason: `verdict=${input.verdict} gate=${gate}`,
    });
    return { toVerifying: true, projectId: runRow.projectId, notify: null };
  });

  // cm:why dispatched AFTER commit, mirroring spawnReconcileRun's enqueue-after-tx pattern — dispatching inside the tx above risks jobs for a run it then rolls back (BLOCKER M path 1, ISS-801 review).
  // cm:why spawnVerifierJobs' OWN try/catch covers the run-open/job-insert/enqueue steps; this outer catch is the backstop for the runners/projects selects and failActiveReconcileRun itself throwing past it — without it a DB blip there leaves the run at 'verifying' with zero verifiers (MINOR W, ISS-801 review round 4).
  if (result.toVerifying) {
    await spawnVerifierJobs(input.runId, result.projectId).catch((err) => {
      logger.error({ err, runId: input.runId }, 'reconcile.verify.spawn.error');
      return failActiveReconcileRun(
        input.runId,
        `failed to spawn verifier jobs: ${String(err)}`,
      ).catch((failErr) =>
        logger.error({ failErr, runId: input.runId }, 'reconcile.verify.spawn.failFallback.error'),
      );
    });
  }

  if (result.notify) {
    await notifyGatePending(input.runId, result.projectId, result.notify).catch((err) =>
      logger.error({ err, runId: input.runId }, 'reconcile.notify.gatePending.error'),
    );
  }
}

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
 *
 * Concurrency: SELECT FOR UPDATE inside the transaction serializes concurrent
 * vote calls for the same run. Duplicate votes from the same jobId are ignored;
 * a vote from a retry clone (see `resolveRetryChainIds`) supersedes its dead
 * ancestor's vote rather than adding a second one for the same verifier slot.
 * The publish transition is additionally guarded by WHERE status='verifying' to
 * remain idempotent if somehow two transactions reach the publish branch.
 */
interface VerifierVoteTxResult {
  /** Set only when this call is the one that transitioned the run to `decided`/human-gate. */
  notify: 'decided' | null;
  projectId: string;
}

export async function recordVerifierVote(input: RecordVerifierVoteInput): Promise<void> {
  const result = await db.transaction(async (tx): Promise<VerifierVoteTxResult> => {
    // cm:why FOR UPDATE row-locks this run, serializing concurrent votes.
    const [runRow] = await tx
      .select()
      .from(reconcileRuns)
      .where(eq(reconcileRuns.id, input.runId))
      .for('update')
      .limit(1);

    if (!runRow) throw new Error(`reconcile run not found: ${input.runId}`);
    if (runRow.status !== 'verifying') {
      logger.warn(
        { runId: input.runId, status: runRow.status },
        'verifier vote received for non-verifying run',
      );
      return { notify: null, projectId: runRow.projectId };
    }

    const existingVotes = (runRow.verifierVotes as ReconcileVerifierVote[]) ?? [];

    if (existingVotes.some((v) => v.jobId === input.jobId)) {
      logger.warn({ runId: input.runId, jobId: input.jobId }, 'duplicate verifier vote — skipping');
      return { notify: null, projectId: runRow.projectId };
    }

    // cm:guard jobId must resolve to a real dispatched verify_skill job bound to this run —
    // a fabricated jobId must never reach the majority tally (BLOCKER C, ISS-801 review).
    const [verifierJob] = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.id, input.jobId),
          eq(jobs.type, 'verify_skill'),
          eq(sql`${jobs.payload}->>'reconcileRunId'`, runRow.id),
        ),
      )
      .limit(1);
    if (!verifierJob) {
      throw new Error(
        `BAD_REQUEST: jobId ${input.jobId} is not a dispatched verify_skill job for run ${input.runId}`,
      );
    }

    const newVote: ReconcileVerifierVote = {
      jobId: input.jobId,
      vote: input.vote,
      reason: input.reason,
      decidedAt: new Date().toISOString(),
    };

    // cm:why a retry clone votes under its OWN jobId (MINOR V) — supersede the dead ancestor's vote instead of tallying both (MINOR AC).
    const retryChainIds = await resolveRetryChainIds(tx, input.jobId);
    const votesWithoutChainAncestor = existingVotes.filter((v) => !retryChainIds.has(v.jobId));
    const allVotes = [...votesWithoutChainAncestor, newVote];

    const passCount = allVotes.filter((v) => v.vote === 'pass').length;
    const failCount = allVotes.filter((v) => v.vote === 'fail').length;

    // cm:why VERIFIER_VOTE_COUNT (module-level, shared with spawnVerifierJobs) is 3 (odd, no ties);
    // 2-of-3 pass auto-publishes (ISS-795 design).
    const MAJORITY = Math.ceil(VERIFIER_VOTE_COUNT / 2);

    const majorityPass = passCount >= MAJORITY;
    const majorityFail = failCount >= MAJORITY;
    const allVoted = allVotes.length >= VERIFIER_VOTE_COUNT;

    await tx
      .update(reconcileRuns)
      .set({ verifierVotes: allVotes, updatedAt: new Date() })
      .where(and(eq(reconcileRuns.id, input.runId), eq(reconcileRuns.status, 'verifying')));

    if (!allVoted && !majorityFail) {
      return { notify: null, projectId: runRow.projectId };
    }

    if (majorityFail || (!majorityPass && allVoted)) {
      await tx
        .update(reconcileRuns)
        .set({ status: 'escalated', updatedAt: new Date() })
        .where(and(eq(reconcileRuns.id, input.runId), eq(reconcileRuns.status, 'verifying')));

      await logActivity(tx, {
        eventType: 'verify.failed',
        actor: 'agent:verifier',
        trigger: 'manual',
        projectId: runRow.projectId,
        skillId: runRow.skillId,
        packetId: runRow.packetId,
        reason: `verifier majority fail: ${failCount}/${allVotes.length}`,
      });
      // cm:why verifier-fail escalation leaves `verdict` at its pre-verifying value (never 'escalate') — the pendingSkillUpdates bucket's escalated clause requires verdict='escalate', so this path is intentionally excluded from the gate notification.
      return { notify: null, projectId: runRow.projectId };
    }

    if (majorityPass) {
      const gate = runRow.gate ?? 'human';
      if (gate === 'human') {
        const updated = await tx
          .update(reconcileRuns)
          .set({ status: 'decided', decidedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(reconcileRuns.id, input.runId), eq(reconcileRuns.status, 'verifying')))
          .returning({ id: reconcileRuns.id });

        await logActivity(tx, {
          eventType: 'reconcile.decided',
          actor: 'agent:verifier',
          trigger: 'manual',
          projectId: runRow.projectId,
          skillId: runRow.skillId,
          packetId: runRow.packetId,
          reason: `verifier pass (${passCount}/${allVotes.length}), awaiting human gate`,
        });
        return { notify: updated.length > 0 ? 'decided' : null, projectId: runRow.projectId };
      }

      if (!runRow.skillId) {
        logger.error({ runId: input.runId }, 'reconcile: cannot auto-publish, skillId is null');
        await tx
          .update(reconcileRuns)
          .set({
            status: 'escalated',
            error: 'skillId is null, cannot auto-publish',
            updatedAt: new Date(),
          })
          .where(and(eq(reconcileRuns.id, input.runId), eq(reconcileRuns.status, 'verifying')));
        return { notify: null, projectId: runRow.projectId };
      }

      const candidateBody = runRow.candidateBody ?? '';
      const lastGoodHash = runRow.lastGoodHash;

      // cm:why fetch existing files before update (reconcile only changes skillMd) so effectiveHash matches what the runner echoes as installedHash, letting resolvePacketIdForHash link device.skill.* events (ISS-798 BLOCKER C).
      const [skillRow] = await tx
        .select({ files: skills.files })
        .from(skills)
        .where(eq(skills.id, runRow.skillId))
        .limit(1);
      const existingFiles = Array.isArray(skillRow?.files) ? skillRow.files : [];
      const effectiveHash = hashSkillBody(candidateBody, existingFiles);

      await tx
        .update(skills)
        .set({
          skillMd: candidateBody,
          prompt: candidateBody,
          contentHash: effectiveHash,
          version: sql`version + 1`,
          updatedAt: new Date(),
        })
        .where(eq(skills.id, runRow.skillId));

      await tx
        .update(reconcileRuns)
        .set({ status: 'applied', decidedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(reconcileRuns.id, input.runId), eq(reconcileRuns.status, 'verifying')));

      await logActivity(tx, {
        eventType: 'skill.body.changed',
        actor: 'agent:master',
        trigger: 'manual',
        projectId: runRow.projectId,
        skillId: runRow.skillId,
        packetId: runRow.packetId,
        beforeHash: lastGoodHash,
        afterHash: effectiveHash,
        reason: `auto-applied; verifier pass ${passCount}/${allVotes.length}; packet=${runRow.packetId}`,
      });
    }

    return { notify: null, projectId: runRow.projectId };
  });

  if (result.notify) {
    await notifyGatePending(input.runId, result.projectId, result.notify).catch((err) =>
      logger.error({ err, runId: input.runId }, 'reconcile.notify.gatePending.error'),
    );
  }
}

/**
 * Human approves a 'decided' (human-gate) run and publishes the candidate body.
 * MUST be called by a project admin (caller must verify authorization).
 */
export async function applyReconcileRun(runId: string, actorUserId: string): Promise<void> {
  await db.transaction(async (tx) => {
    // cm:why FOR UPDATE row-locks this run, serializing concurrent apply/reject calls.
    const [runRow] = await tx
      .select()
      .from(reconcileRuns)
      .where(eq(reconcileRuns.id, runId))
      .for('update')
      .limit(1);

    if (!runRow) throw new Error(`NOT_FOUND: reconcile run ${runId}`);
    if (runRow.status !== 'decided') {
      throw new Error(`BAD_REQUEST: run is in status '${runRow.status}', expected 'decided'`);
    }
    if (!runRow.skillId) {
      throw new Error('BAD_REQUEST: run has no skillId — cannot publish');
    }

    const candidateBody = runRow.candidateBody ?? '';
    const lastGoodHash = runRow.lastGoodHash;

    // cm:why fetch existing files before update (reconcile only changes skillMd) so effectiveHash matches what the runner echoes as installedHash, letting resolvePacketIdForHash link device.skill.* events (ISS-798 BLOCKER C).
    const skillIdForPublish = runRow.skillId;
    const [skillRow] = await tx
      .select({ files: skills.files })
      .from(skills)
      .where(eq(skills.id, skillIdForPublish))
      .limit(1);
    const existingFiles = Array.isArray(skillRow?.files) ? skillRow.files : [];
    const effectiveHash = hashSkillBody(candidateBody, existingFiles);

    await tx
      .update(skills)
      .set({
        skillMd: candidateBody,
        prompt: candidateBody,
        contentHash: effectiveHash,
        version: sql`version + 1`,
        updatedAt: new Date(),
      })
      .where(eq(skills.id, skillIdForPublish));

    await tx
      .update(reconcileRuns)
      .set({ status: 'applied', decidedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(reconcileRuns.id, runId), eq(reconcileRuns.status, 'decided')));

    await logActivity(tx, {
      eventType: 'skill.body.changed',
      actor: `human:${actorUserId}`,
      trigger: 'manual',
      projectId: runRow.projectId,
      skillId: runRow.skillId,
      packetId: runRow.packetId,
      beforeHash: lastGoodHash,
      afterHash: effectiveHash,
      reason: `human approved; packet=${runRow.packetId}`,
    });
  });

  // cm:why after commit — resolveNotifications is itself best-effort (catches + logs internally).
  await resolveNotifications(`reconcile_run:${runId}:gate`);
}

// cm:guard reconcileRuns terminal states — keep this set in sync with any new reconcileRuns.status value
const RECONCILE_RUN_TERMINAL_STATUSES = ['applied', 'escalated', 'failed'];

/**
 * Human rejects a run — escalates it, preserving the last-good body. Accepts
 * any non-terminal state (`pending`/`running`/`verifying`/`decided`), not
 * just `decided`: a run can get stuck in any of those states (e.g. an
 * orphaned reconcile_runs row left behind by a job cancel, ISS-808) and
 * `reject` is the only recovery path a human has for it. There is no
 * candidate body to preserve for a non-`decided` run — escalating is safe
 * from any active state since it is FOR-UPDATE row-locked above.
 */
export async function rejectReconcileRun(
  runId: string,
  actorUserId: string,
  reason: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    // cm:why FOR UPDATE row-locks this run, serializing concurrent apply/reject calls.
    const [runRow] = await tx
      .select()
      .from(reconcileRuns)
      .where(eq(reconcileRuns.id, runId))
      .for('update')
      .limit(1);

    if (!runRow) throw new Error(`NOT_FOUND: reconcile run ${runId}`);
    if (RECONCILE_RUN_TERMINAL_STATUSES.includes(runRow.status)) {
      throw new Error(
        `BAD_REQUEST: run is in terminal status '${runRow.status}', nothing to reject`,
      );
    }

    await tx
      .update(reconcileRuns)
      .set({ status: 'escalated', updatedAt: new Date() })
      .where(and(eq(reconcileRuns.id, runId), eq(reconcileRuns.status, runRow.status)));

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

  // cm:why after commit — resolveNotifications is itself best-effort (catches + logs internally). A reject also produces the resolution: no further action is owed on this run.
  await resolveNotifications(`reconcile_run:${runId}:gate`);
}

/**
 * Human acknowledges an `escalated`/`verdict=escalate` run — clears its
 * attention item without touching `status`, which stays the run's true
 * terminal state. Idempotent: a second call on an already-acknowledged run
 * is a no-op, not an error.
 */
export async function acknowledgeReconcileRun(
  runId: string,
  actorUserId: string,
  reason?: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    // cm:why FOR UPDATE row-locks this run, serializing concurrent acknowledge calls.
    const [runRow] = await tx
      .select()
      .from(reconcileRuns)
      .where(eq(reconcileRuns.id, runId))
      .for('update')
      .limit(1);

    if (!runRow) throw new Error(`NOT_FOUND: reconcile run ${runId}`);
    if (runRow.status !== 'escalated' || runRow.verdict !== 'escalate') {
      throw new Error(
        `BAD_REQUEST: run is in status '${runRow.status}' verdict '${runRow.verdict}', expected 'escalated'/'escalate'`,
      );
    }
    if (runRow.acknowledgedAt) return;

    await tx
      .update(reconcileRuns)
      .set({ acknowledgedAt: new Date(), acknowledgedBy: actorUserId, updatedAt: new Date() })
      .where(and(eq(reconcileRuns.id, runId), sql`acknowledged_at IS NULL`));

    await logActivity(tx, {
      eventType: 'reconcile.acknowledged',
      actor: `human:${actorUserId}`,
      trigger: 'manual',
      projectId: runRow.projectId,
      skillId: runRow.skillId,
      packetId: runRow.packetId,
      reason: reason || 'human acknowledged escalated run',
    });
  });

  // cm:why after commit — resolveNotifications is itself best-effort (catches + logs internally).
  await resolveNotifications(`reconcile_run:${runId}:gate`);
}

/**
 * Terminal-path hook for a `reconcile`/`verify_skill` job that just went
 * `failed` (BLOCKER M, ISS-801 review). Without this, a job failure (adapter
 * error, timeout, budget exhaustion, reaper) left `reconcile_runs` stuck at
 * `pending`/`running`/`verifying` forever — `reconcile_runs_active_project_uq`
 * then blocks every future run for the project, needing SQL surgery to clear.
 * No-op for any other job type, and for a run already past the active set
 * (a verdict/vote already landed before the job's failure was observed).
 *
 * Called from `finalizeFailedJob` (jobs/finalize-failure.ts) unconditionally
 * (reconcile jobs carry `issueId: null`, so the issue-status reconcile path
 * there does not apply).
 */
export async function failReconcileRunForFailedJob(job: {
  type: string;
  payload: unknown;
}): Promise<void> {
  if (job.type !== 'reconcile' && job.type !== 'verify_skill') return;
  const runId = (job.payload as { reconcileRunId?: unknown } | null)?.reconcileRunId;
  if (typeof runId !== 'string') return;

  await failActiveReconcileRun(runId, `${job.type} job failed without recording a verdict`);
}

/**
 * Terminal-path hook for a `reconcile`/`verify_skill` job that ended `done` or
 * `cancelled` WITHOUT ever recording the write its termination protocol
 * requires (BLOCKER M — half 2, ISS-801 review). Three cases this closes:
 *   1. A `reconcile` job ends without ever calling `record_verdict` — the run
 *      is still stuck at `pending`/`running` (SKILL.md non-compliance, or the
 *      false-BLOCKER-R prompt never invoking the agent at all).
 *   2. A `verify_skill` job ends without this job's own vote landing in
 *      `verifierVotes` — the run is still `verifying`, and since
 *      `recordVerifierVote`'s majority tally always waits for
 *      `VERIFIER_VOTE_COUNT` votes, a missing one leaves it stuck forever.
 *   3. Called from `cascadeCancelChildJobs` for the same two job types
 *      (BLOCKER M path 3) — a pipeline_run closing out from under an
 *      in-flight reconcile/verifier job cancels the child without it ever
 *      getting a chance to record anything.
 * No-op for any other job type, when the run has already left the active set
 * (its own verdict/vote/apply/reject already landed), or — for `verify_skill`
 * — when this job's vote is already recorded (the normal case: the job did
 * its job and ended `done`, and the run may legitimately still be
 * `verifying` awaiting the other voters).
 */
export async function failReconcileRunIfNoVerdictRecorded(job: {
  id: string;
  type: string;
  payload: unknown;
}): Promise<void> {
  if (job.type !== 'reconcile' && job.type !== 'verify_skill') return;
  const runId = (job.payload as { reconcileRunId?: unknown } | null)?.reconcileRunId;
  if (typeof runId !== 'string') return;

  const runRow = await getReconcileRun(runId);
  if (!runRow) return;

  if (job.type === 'reconcile') {
    if (runRow.status !== 'pending' && runRow.status !== 'running') return;
    await failActiveReconcileRun(runId, 'reconcile job ended without recording a verdict');
    return;
  }

  if (runRow.status !== 'verifying') return;
  const votes = (runRow.verifierVotes as ReconcileVerifierVote[]) ?? [];
  if (votes.some((v) => v.jobId === job.id)) return;
  await failActiveReconcileRun(runId, 'verify_skill job ended without recording a vote');
}

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
