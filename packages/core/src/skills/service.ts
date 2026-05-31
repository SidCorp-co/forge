import { and, eq, isNotNull, ne, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type IssueStatus,
  type SkillTarget,
  projectSkillOverrides,
  projects,
  runners,
  skillRegistrations,
  skills,
} from '../db/schema.js';
import { hooks } from '../pipeline/hooks.js';
import { PIPELINE_STEPS } from '../pipeline/registry.js';
import { globalEffectiveHash } from './effective.js';
import { hashSkillBody } from './hash.js';

export interface SkillFileInput {
  path: string;
  content: string;
  encoding?: 'utf8' | 'base64' | undefined;
}

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

/**
 * Shared CRUD used by BOTH the REST routes and the MCP tools so the two
 * surfaces can never drift. None of these check authorization — callers must
 * verify owner/admin first. All create project-scoped skills only; global
 * skills are managed by the boot-time seeder, never via these paths.
 */
export interface CreateProjectSkillInput {
  projectId: string;
  name: string;
  description: string;
  skillMd: string;
  target?: SkillTarget | null | undefined;
  files?: SkillFileInput[] | undefined;
  localGuide?: string | null | undefined;
}

export async function createProjectSkill(input: CreateProjectSkillInput): Promise<SkillRow> {
  const files = input.files ?? [];
  const contentHash = hashSkillBody(input.skillMd, files);
  const [inserted] = (await db
    .insert(skills)
    .values({
      name: input.name,
      description: input.description,
      scope: 'project',
      projectId: input.projectId,
      prompt: input.skillMd, // keep prompt in sync with skillMd for runtime
      tools: [],
      manifest: {},
      source: 'user',
      contentHash,
      skillMd: input.skillMd,
      target: input.target ?? null,
      files: files as never,
      localGuide: input.localGuide ?? null,
    })
    .returning(skillProjection)) as SkillRow[];
  if (!inserted) throw new Error('skills: insert returned no row');
  return inserted;
}

export interface UpdateProjectSkillPatch {
  name?: string | undefined;
  description?: string | undefined;
  skillMd?: string | undefined;
  target?: SkillTarget | null | undefined;
  files?: SkillFileInput[] | undefined;
  localGuide?: string | null | undefined;
}

/**
 * Apply a partial update to a project skill. `existing` is the current row
 * (fetched + authorized by the caller). Bumps `version` + recomputes
 * `contentHash` whenever the body (skillMd) or files change; backfills the
 * canonical `skillMd` for legacy prompt-only rows on first edit.
 */
export async function updateProjectSkill(
  existing: Pick<SkillRow, 'id' | 'skillMd' | 'prompt' | 'files' | 'version'>,
  patch: UpdateProjectSkillPatch,
): Promise<SkillRow> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) updates.name = patch.name;
  if (patch.description !== undefined) updates.description = patch.description;
  if (patch.skillMd !== undefined) {
    updates.skillMd = patch.skillMd;
    updates.prompt = patch.skillMd;
  }
  if (patch.target !== undefined) updates.target = patch.target;
  if (patch.files !== undefined) updates.files = patch.files;
  if (patch.localGuide !== undefined) updates.localGuide = patch.localGuide;
  if (patch.skillMd !== undefined || patch.files !== undefined) {
    const canonicalSkillMd = patch.skillMd ?? existing.skillMd ?? existing.prompt;
    if (patch.skillMd === undefined && existing.skillMd === null) {
      updates.skillMd = canonicalSkillMd;
      updates.prompt = canonicalSkillMd;
    }
    updates.contentHash = hashSkillBody(canonicalSkillMd, patch.files ?? existing.files);
    updates.version = (existing.version ?? 1) + 1;
  }
  const [updated] = (await db
    .update(skills)
    .set(updates)
    .where(eq(skills.id, existing.id))
    .returning(skillProjection)) as SkillRow[];
  if (!updated) throw new Error('skills: update returned no row');
  return updated;
}

export async function deleteProjectSkill(skillId: string): Promise<void> {
  await db.delete(skills).where(eq(skills.id, skillId));
}

/**
 * Resolve the device-bound runners for a project to a distinct set of device
 * ids, optionally narrowed to one device. Remote (host='remote') runners have
 * no device and are excluded — skills sync to a filesystem, which only a
 * device-bound runner (desktop or CLI) has.
 */
export async function listProjectSyncDeviceIds(
  projectId: string,
  deviceId?: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ deviceId: runners.deviceId })
    .from(runners)
    .where(
      deviceId
        ? and(eq(runners.projectId, projectId), eq(runners.deviceId, deviceId))
        : and(eq(runners.projectId, projectId), isNotNull(runners.deviceId)),
    );
  return rows.map((r) => r.deviceId).filter((d): d is string => d != null);
}

export interface RequestSkillSyncInput {
  projectId: string;
  actorUserId: string;
  skillNames?: string[] | null | undefined;
  /** Narrow to a single device; omit to push to every device-bound runner. */
  deviceId?: string | undefined;
}

export interface RequestSkillSyncResult {
  projectId: string;
  deviceIds: string[];
}

/**
 * The single explicit-push entrypoint shared by the web Sync actions and the
 * `forge_skills.push` MCP tool. Resolves the project's device-bound runners,
 * emits `skillSyncRequested` (→ one `skill.sync` WS command per device room),
 * and returns the devices that were signalled. No-op (empty deviceIds) when
 * the project has no device-bound runner. Never seeds skills itself — the
 * device pulls + reports.
 */
export async function requestSkillSync(
  input: RequestSkillSyncInput,
): Promise<RequestSkillSyncResult> {
  const [project] = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .limit(1);
  if (!project) throw new Error('NOT_FOUND: project not found');

  const deviceIds = await listProjectSyncDeviceIds(input.projectId, input.deviceId);
  if (deviceIds.length > 0) {
    await hooks.emit('skillSyncRequested', {
      projectId: input.projectId,
      projectSlug: project.slug,
      deviceIds,
      skillNames: input.skillNames ?? null,
      actorUserId: input.actorUserId,
    });
  }
  return { projectId: input.projectId, deviceIds };
}

/**
 * Override CRUD shared by the REST override routes and the MCP override tools.
 * `skill` is the already-loaded GLOBAL skill row (caller validates scope +
 * authorization). Hashes are derived here so no client can drift them, and the
 * `skillUpdated` hook is emitted for web cache-invalidation.
 */
export interface UpsertSkillOverrideInput {
  projectId: string;
  skill: { id: string; name: string; files: unknown; skillMd: string | null; prompt: string | null };
  skillMdOverride: string;
  files?: SkillFileInput[] | undefined;
  actorUserId: string;
}

export async function upsertSkillOverride(input: UpsertSkillOverrideInput) {
  const { projectId, skill, skillMdOverride, files, actorUserId } = input;
  const [existing] = await db
    .select({ id: projectSkillOverrides.id, files: projectSkillOverrides.files })
    .from(projectSkillOverrides)
    .where(
      and(
        eq(projectSkillOverrides.projectId, projectId),
        eq(projectSkillOverrides.skillId, skill.id),
      ),
    )
    .limit(1);

  let row;
  if (existing) {
    const effectiveFiles = files ?? (Array.isArray(existing.files) ? existing.files : []);
    const contentHash = hashSkillBody(skillMdOverride, effectiveFiles);
    [row] = await db
      .update(projectSkillOverrides)
      .set({ skillMdOverride, files: effectiveFiles as never, contentHash, updatedAt: new Date() })
      .where(eq(projectSkillOverrides.id, existing.id))
      .returning();
  } else {
    const forkedFiles = files ?? (Array.isArray(skill.files) ? skill.files : []);
    const contentHash = hashSkillBody(skillMdOverride, forkedFiles);
    const globalContentHash = globalEffectiveHash(skill);
    [row] = await db
      .insert(projectSkillOverrides)
      .values({
        projectId,
        skillId: skill.id,
        skillMdOverride,
        files: forkedFiles as never,
        contentHash,
        globalContentHash,
      })
      .returning();
  }
  if (!row) throw new Error('project_skill_overrides: upsert returned no row');

  await hooks.emit('skillUpdated', {
    projectId,
    skillId: skill.id,
    name: skill.name,
    action: 'upsert',
    contentHash: row.contentHash,
    actorUserId,
  });
  return row;
}

export async function deleteSkillOverride(input: {
  projectId: string;
  skill: { id: string; name: string };
  actorUserId: string;
}): Promise<boolean> {
  const { projectId, skill, actorUserId } = input;
  const result = await db
    .delete(projectSkillOverrides)
    .where(
      and(
        eq(projectSkillOverrides.projectId, projectId),
        eq(projectSkillOverrides.skillId, skill.id),
      ),
    )
    .returning({ id: projectSkillOverrides.id });
  if (result.length === 0) return false;

  await hooks.emit('skillUpdated', {
    projectId,
    skillId: skill.id,
    name: skill.name,
    action: 'delete',
    contentHash: null,
    actorUserId,
  });
  return true;
}
