import { and, eq, ne, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type IssueStatus,
  type SkillTarget,
  projects,
  skillRegistrations,
  skills,
} from '../db/schema.js';
import { hooks } from '../pipeline/hooks.js';
import { PIPELINE_STEPS } from '../pipeline/registry.js';

/**
 * Pure-ish helpers shared between the F2 REST routes and the F4 MCP tools.
 * None of these check authorization — callers must verify membership/role
 * before invoking.
 */

export type SkillRow = {
  id: string;
  name: string;
  description: string;
  scope: 'global' | 'project';
  projectId: string | null;
  prompt: string;
  tools: unknown;
  manifest: unknown;
  version: number;
  contentHash: string;
  skillMd: string | null;
  target: SkillTarget | null;
  files: unknown;
  changelog: unknown;
  localGuide: string | null;
  evalScore: number | null;
};

const skillProjection = {
  id: skills.id,
  name: skills.name,
  description: skills.description,
  scope: skills.scope,
  projectId: skills.projectId,
  prompt: skills.prompt,
  tools: skills.tools,
  manifest: skills.manifest,
  version: skills.version,
  contentHash: skills.contentHash,
  skillMd: skills.skillMd,
  target: skills.target,
  files: skills.files,
  changelog: skills.changelog,
  localGuide: skills.localGuide,
  evalScore: skills.evalScore,
} as const;

/**
 * List all skills visible to a project: its own project-scoped skills plus
 * every global skill. Ordered by scope then name — result shape matches the
 * `forge_skills.list` MCP tool and the REST list endpoint.
 */
export async function listProjectSkills(projectId: string): Promise<SkillRow[]> {
  return db
    .select(skillProjection)
    .from(skills)
    .where(or(eq(skills.scope, 'global'), eq(skills.projectId, projectId)))
    .orderBy(skills.scope, skills.name) as Promise<SkillRow[]>;
}

/**
 * Fetch a skill by id, but only return it if it is either global or scoped
 * to the caller's project. Returns null for cross-project skills so the
 * caller sees the same "not found" response either way (no information
 * leak on id existence).
 */
export async function getSkillForProject(
  skillId: string,
  projectId: string,
): Promise<SkillRow | null> {
  const [row] = (await db
    .select(skillProjection)
    .from(skills)
    .where(eq(skills.id, skillId))
    .limit(1)) as SkillRow[];
  if (!row) return null;
  if (row.scope === 'project' && row.projectId !== projectId) return null;
  return row;
}

/**
 * Bind (or clear) a skill to a pipeline stage for a project. Matches the F2
 * REST behaviour: atomic upsert on `(projectId, stage)` then remove any
 * other stage rows this skill previously held (one-stage-per-skill rule).
 *
 * Returns the resulting registration (or null stage when cleared).
 */
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

export async function registerSkillForProject(
  input: RegisterSkillInput,
): Promise<RegisterSkillResult> {
  const { projectId, skillId, stage, actorUserId } = input;

  if (stage === null) {
    // ISS-238 — block deletion when the corresponding `auto<Stage>` toggle is
    // on. Silently unbinding would create the exact "enabled without skill"
    // state the orchestrator guard pauses on; rejecting at the API surface
    // forces the operator to flip the toggle first.
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
          (typeof v === 'object' &&
            v !== null &&
            (v as { enabled?: boolean }).enabled !== false);
        if (on) {
          throw new SkillDeleteBlockedError(reg.stage as IssueStatus, step.toggle);
        }
      }
    }

    await db
      .delete(skillRegistrations)
      .where(
        and(eq(skillRegistrations.projectId, projectId), eq(skillRegistrations.skillId, skillId)),
      );
    await hooks.emit('skillRegistered', { projectId, skillId, actorUserId, stage: null });
    return { projectId, skillId, stage: null };
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
export async function listSkillRegistrations(
  projectId: string,
): Promise<SkillRegistrationView[]> {
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
      registeredAt:
        r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    };
  });
}
