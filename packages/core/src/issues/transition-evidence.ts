/**
 * Content guards on THE state-machine writer (`transitionIssueStatus`).
 * Rules run for `actorType==='device'` only — a human hand-advance is a
 * recorded human decision, not the fabrication class this guards against —
 * and are skipped entirely for `options.skip===true` (the orchestrator's
 * curated soft-skip/failover chain, which legitimately lands on gated
 * statuses without the evidence a normal write would require). This is the
 * shared extension point ISS-821 (ISS-786 child B) extends with a second
 * rule (`no_work_evidence`).
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, projects } from '../db/schema.js';
import { logger } from '../logger.js';
import { pipelineConfigSchema } from '../pipeline/pipeline-config-schema.js';
import {
  type ProjectSkillResolver,
  createProjectSkillResolver,
} from '../pipeline/skill-mapping.js';
import { findMissingWorkEvidence } from '../pipeline/work-evidence.js';
import type { TransitionErrorCode, TransitionIssueRow } from './apply-transition.js';

export interface TransitionEvidenceViolation {
  code: TransitionErrorCode;
  detail: string;
  details: Record<string, unknown>;
}

export interface TransitionEvidenceContext {
  issue: Pick<TransitionIssueRow, 'id' | 'projectId'>;
  toStatus: string;
  actorType: 'user' | 'device';
  skip: boolean;
}

type EvidenceRule = (ctx: TransitionEvidenceContext) => Promise<TransitionEvidenceViolation | null>;

/**
 * Is the project's plan stage live — `clarified` not explicitly disabled AND
 * a skill is registered for it? Fails open (returns false — "not live", so
 * the caller's blank-plan check never fires) on any read error, matching the
 * `bounce-replay-guard.ts` / `empty-reopen-guard.ts` convention. Reused by
 * the `considerEnqueue` dispatch-side backstop (orchestrator.ts), which
 * passes its already-memoized resolver to avoid a second
 * `skill_registrations` load per hook fire.
 */
// cm:guard fails OPEN — a broken read here must never block a legitimate approval
export async function isPlanStageLive(
  projectId: string,
  resolver?: Pick<ProjectSkillResolver, 'stages'>,
): Promise<boolean> {
  try {
    const [project] = await db
      .select({ agentConfig: projects.agentConfig })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) return false;
    const ac = (project.agentConfig as { pipelineConfig?: unknown } | null) ?? {};
    const parsed = pipelineConfigSchema.safeParse(ac.pipelineConfig ?? {});
    if (!parsed.success || parsed.data.states?.clarified?.enabled === false) return false;
    const stages = await (resolver ?? createProjectSkillResolver(projectId)).stages();
    return stages.has('clarified');
  } catch (err) {
    logger.warn(
      { err, projectId },
      'transition-evidence: plan-stage-live check failed, treating as not live',
    );
    return false;
  }
}

export const isBlankPlan = (plan: string | null | undefined): boolean =>
  !plan || plan.trim().length === 0;

/**
 * Requirement 1 (ISS-819) — `approved` must not be reachable with a blank
 * plan when the project's plan stage is live. Projects with no plan stage
 * (or one explicitly disabled) are unaffected.
 */
const planRequiredRule: EvidenceRule = async (ctx) => {
  if (ctx.toStatus !== 'approved') return null;
  const [row] = await db
    .select({ plan: issues.plan })
    .from(issues)
    .where(eq(issues.id, ctx.issue.id))
    .limit(1);
  if (!row || !isBlankPlan(row.plan)) return null;
  if (!(await isPlanStageLive(ctx.issue.projectId))) return null;
  return {
    code: 'PLAN_REQUIRED',
    detail: 'issue has no plan written — write the issue plan before advancing to approved',
    details: { issueId: ctx.issue.id },
  };
};

/**
 * Statuses that assert "code exists". `closed`/`released` are deliberately
 * excluded — a decompose/coordination epic legitimately reaches them with no
 * branch of its own (its children carry the code), and `markMergedOnClose`'s
 * unconditional stamp on `closed` is out of scope for this rule (ISS-786
 * epic explicitly forbids re-litigating it).
 */
const NO_WORK_EVIDENCE_STATUSES: ReadonlySet<string> = new Set(['developed', 'testing']);

/**
 * Requirement 1 (ISS-786 child B) — `developed`/`testing` must not be
 * reachable with zero recorded evidence that code exists (ISS-105 / ISS-75-78
 * shape: a status advance with no branch, commit or handoff behind it).
 */
const noWorkEvidenceRule: EvidenceRule = async (ctx) => {
  if (!NO_WORK_EVIDENCE_STATUSES.has(ctx.toStatus)) return null;
  const detail = await findMissingWorkEvidence(ctx.issue.id);
  if (!detail) return null;
  return {
    code: 'NO_WORK_EVIDENCE',
    detail,
    details: { issueId: ctx.issue.id, toStatus: ctx.toStatus },
  };
};

const RULES: readonly EvidenceRule[] = [planRequiredRule, noWorkEvidenceRule];

// cm:guard fails OPEN on any internal error — a broken content guard must never freeze the writer
export async function checkTransitionEvidence(
  ctx: TransitionEvidenceContext,
): Promise<TransitionEvidenceViolation | null> {
  if (ctx.actorType !== 'device' || ctx.skip) return null;
  try {
    for (const rule of RULES) {
      const violation = await rule(ctx);
      if (violation) return violation;
    }
    return null;
  } catch (err) {
    logger.error(
      { err, issueId: ctx.issue.id, toStatus: ctx.toStatus },
      'transition-evidence: rule check failed, allowing transition',
    );
    return null;
  }
}
