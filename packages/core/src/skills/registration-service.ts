/**
 * Which skill serves which pipeline stage — registration, distinct from the
 * skill CRUD in `service.ts`. Split out when that file crossed its line budget
 * (ISS-894 wave 3); the seam is the concern, not the size.
 */

/**
 * Bind (or clear) a skill to a pipeline stage for a project. Matches the F2
 * REST behaviour: atomic upsert on `(projectId, stage)` then remove any
 * other stage rows this skill previously held (one-stage-per-skill rule).
 *
 * Returns the resulting registration (or null stage when cleared).
 */
import { and, eq, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, projects, skillRegistrations, skills } from '../db/schema.js';
import { hooks } from '../pipeline/hooks.js';
import { PIPELINE_STEPS } from '../pipeline/registry.js';
import { recordSkillActivityEvent } from './activity.js';

export interface RegisterSkillInput {
  projectId: string;
  skillId: string;
  stage: IssueStatus | null;
  actorUserId: string;
}

export interface RegisterSkillResult {
  projectId: string;
  skillId: string;
  stage: IssueStatus | null;
}

export class SkillDeleteBlockedError extends Error {
  readonly code = 'SKILL_DELETE_BLOCKED_BY_AUTO_TOGGLE';
  readonly stage: IssueStatus;
  readonly toggle: string;
  constructor(stage: IssueStatus, toggle: string) {
    super(`SKILL_DELETE_BLOCKED_BY_AUTO_TOGGLE: stage '${stage}' has '${toggle}=true'`);
    this.name = 'SkillDeleteBlockedError';
    this.stage = stage;
    this.toggle = toggle;
  }
}

/**
 * Thrown when a stage registration targets a skill that is not a project skill
 * owned by this project. Only project skills are usable — adopt the global
 * template first (`applyGlobalSkillDefault`).
 */
export class SkillNotProjectScopedError extends Error {
  readonly code = 'SKILL_NOT_PROJECT_SCOPED';
  constructor(skillId: string) {
    super(
      `SKILL_NOT_PROJECT_SCOPED: skill '${skillId}' is not a project skill for this project; adopt the global template into the project before registering it`,
    );
    this.name = 'SkillNotProjectScopedError';
  }
}

export async function registerSkillForProject(
  input: RegisterSkillInput,
): Promise<RegisterSkillResult> {
  const { projectId, skillId, stage, actorUserId } = input;

  if (stage === null) {
    // cm:guard ISS-238 — refuse the unbind while the matching `auto<Stage>` toggle is ON, at this surface rather than downstream. Silently unbinding produces the "enabled without skill" state the orchestrator guard pauses on, so the pipeline stops later with no trace of what caused it; failing here forces the operator to flip the toggle first, which is the decision they actually have to make.
    const [reg] = await db
      .select({ stage: skillRegistrations.stage })
      .from(skillRegistrations)
      .where(
        and(eq(skillRegistrations.projectId, projectId), eq(skillRegistrations.skillId, skillId)),
      )
      .limit(1);
    if (reg) {
      const step = PIPELINE_STEPS.find((s) => s.status === reg.stage);
      if (step) {
        const [project] = await db
          .select({ agentConfig: projects.agentConfig })
          .from(projects)
          .where(eq(projects.id, projectId))
          .limit(1);
        const ac = (project?.agentConfig ?? {}) as { pipelineConfig?: Record<string, unknown> };
        const pipeline = ac.pipelineConfig ?? {};
        const v = (pipeline as Record<string, unknown>)[step.toggle];
        const on =
          v === true ||
          (typeof v === 'object' && v !== null && (v as { enabled?: boolean }).enabled !== false);
        if (on) {
          throw new SkillDeleteBlockedError(reg.stage as IssueStatus, step.toggle);
        }
      }
    }

    await db.transaction(async (tx) => {
      await tx
        .delete(skillRegistrations)
        .where(
          and(eq(skillRegistrations.projectId, projectId), eq(skillRegistrations.skillId, skillId)),
        );
      if (reg) {
        await recordSkillActivityEvent(tx, {
          eventType: 'manifest.changed',
          actor: `human:${actorUserId}`,
          trigger: 'manual',
          projectId,
          skillId,
          deltaSummary: `unregistered from ${reg.stage}`,
        });
      }
    });
    await hooks.emit('skillRegistered', { projectId, skillId, actorUserId, stage: null });
    return { projectId, skillId, stage: null };
  }

  // cm:guard only a project skill owned by THIS project may be registered — a global is a template and must be adopted (cloned) first
  const [target] = await db
    .select({ scope: skills.scope, projectId: skills.projectId })
    .from(skills)
    .where(eq(skills.id, skillId))
    .limit(1);
  if (target?.scope !== 'project' || target.projectId !== projectId) {
    throw new SkillNotProjectScopedError(skillId);
  }

  await db.transaction(async (tx) => {
    await tx
      .insert(skillRegistrations)
      .values({ projectId, skillId, stage, registeredBy: actorUserId })
      .onConflictDoUpdate({
        target: [skillRegistrations.projectId, skillRegistrations.stage],
        set: { skillId, registeredBy: actorUserId },
      });
    await tx
      .delete(skillRegistrations)
      .where(
        and(
          eq(skillRegistrations.projectId, projectId),
          eq(skillRegistrations.skillId, skillId),
          ne(skillRegistrations.stage, stage),
        ),
      );
    await recordSkillActivityEvent(tx, {
      eventType: 'manifest.changed',
      actor: `human:${actorUserId}`,
      trigger: 'manual',
      projectId,
      skillId,
      deltaSummary: `registered at stage ${stage}`,
    });
  });

  await hooks.emit('skillRegistered', { projectId, skillId, actorUserId, stage });
  return { projectId, skillId, stage };
}

export interface SkillRegistrationView {
  stage: IssueStatus;
  skillId: string;
  skillName: string;
  scope: 'global' | 'project';
  mode: 'auto' | 'manual';
  enabled: boolean;
  registeredBy: string | null;
  registeredAt: string;
}

/**
 * List a project's stage→skill bindings overlaid with the per-stage
 * `mode`/`enabled` from `agentConfig.pipelineConfig.states`. Plan agents call
 * this to decide whether to dispatch into a stage that is registered but
 * configured `manual` or disabled.
 *
 * Stages with no skill registered are NOT returned — clients diff against
 * the canonical stage list (`STAGE_NAMES`) to surface gaps.
 */
export async function listSkillRegistrations(projectId: string): Promise<SkillRegistrationView[]> {
  const [project] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return [];
  const ac = (project.agentConfig ?? {}) as Record<string, unknown>;
  const pipeline = (ac.pipelineConfig ?? {}) as Record<string, unknown>;
  const states = (pipeline.states ?? {}) as Record<
    string,
    { enabled?: boolean; mode?: 'auto' | 'manual' } | undefined
  >;

  const rows = await db
    .select({
      stage: skillRegistrations.stage,
      skillId: skillRegistrations.skillId,
      skillName: skills.name,
      scope: skills.scope,
      registeredBy: skillRegistrations.registeredBy,
      createdAt: skillRegistrations.createdAt,
    })
    .from(skillRegistrations)
    .innerJoin(skills, eq(skills.id, skillRegistrations.skillId))
    .where(eq(skillRegistrations.projectId, projectId))
    .orderBy(skillRegistrations.stage);

  return rows.map((r) => {
    const stageCfg = states[r.stage];
    return {
      stage: r.stage as IssueStatus,
      skillId: r.skillId,
      skillName: r.skillName,
      scope: r.scope as 'global' | 'project',
      mode: stageCfg?.mode ?? 'auto',
      enabled: stageCfg?.enabled !== false,
      registeredBy: r.registeredBy,
      registeredAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    };
  });
}
