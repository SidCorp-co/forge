import { and, eq, isNotNull, ne, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type IssueStatus,
  type SkillTarget,
  projects,
  runners,
  skillRegistrations,
  skills,
} from '../db/schema.js';
import { logger } from '../logger.js';
import { hooks } from '../pipeline/hooks.js';
import { PIPELINE_STEPS } from '../pipeline/registry.js';
import { SkillContentBlockedError } from '../security/findings.js';
import { scanSkillContent } from '../security/skill-content-scanner.js';
import { hashSkillBody } from './hash.js';

export interface SkillFileInput {
  path: string;
  content: string;
  encoding?: 'utf8' | 'base64' | undefined;
}

/**
 * Default a file's `encoding` to 'utf8' when the caller omits it. The REST
 * route defaults via zod, but the MCP tools call this service directly — and a
 * file persisted with no `encoding` makes the runner's skill-content decode
 * fail (its `SkillFile.encoding` is a required string), which silently aborts
 * the WHOLE project sync. Normalize at the service chokepoint so both the REST
 * and MCP surfaces can never store an encoding-less file.
 */
function normalizeSkillFiles(files: SkillFileInput[]): SkillFileInput[] {
  return files.map((f) => ({
    path: f.path,
    content: f.content,
    encoding: f.encoding ?? 'utf8',
  }));
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

/**
 * Thrown when a stage registration targets a skill that is not a project skill
 * owned by this project. Only project skills are usable — adopt the global
 * template first (`applyGlobalSkillDefault`). See docs/skills-scope-playbook.md
 * (Rule 4).
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
          (typeof v === 'object' && v !== null && (v as { enabled?: boolean }).enabled !== false);
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

  // Single path: only a project skill owned by THIS project may be registered.
  // Globals are templates — they must be adopted (cloned) into the project
  // first. See docs/skills-scope-playbook.md (Rule 4).
  const [target] = await db
    .select({ scope: skills.scope, projectId: skills.projectId })
    .from(skills)
    .where(eq(skills.id, skillId))
    .limit(1);
  if (!target || target.scope !== 'project' || target.projectId !== projectId) {
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
  const scanFindings = scanSkillContent({
    name: input.name,
    description: input.description,
    skillMd: input.skillMd,
  });
  const blockers = scanFindings.filter((f) => f.severity === 'blocker');
  if (blockers.length > 0) throw new SkillContentBlockedError(blockers);
  const warns = scanFindings.filter((f) => f.severity === 'warn');
  if (warns.length > 0) {
    logger.warn(
      { findings: warns, skillName: input.name },
      'skill-content-scanner: non-blocking findings on create',
    );
  }

  const files = normalizeSkillFiles(input.files ?? []);
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
  existing: Pick<
    SkillRow,
    'id' | 'skillMd' | 'prompt' | 'files' | 'version' | 'name' | 'description'
  >,
  patch: UpdateProjectSkillPatch,
): Promise<SkillRow> {
  const hasTextPatch =
    patch.skillMd !== undefined || patch.description !== undefined || patch.name !== undefined;
  if (hasTextPatch) {
    const scanFindings = scanSkillContent({
      name: patch.name ?? existing.name,
      description: patch.description ?? existing.description,
      skillMd: patch.skillMd ?? existing.skillMd ?? existing.prompt ?? '',
    });
    const blockers = scanFindings.filter((f) => f.severity === 'blocker');
    if (blockers.length > 0) throw new SkillContentBlockedError(blockers);
    const warns = scanFindings.filter((f) => f.severity === 'warn');
    if (warns.length > 0) {
      logger.warn(
        { findings: warns, skillId: existing.id },
        'skill-content-scanner: non-blocking findings on update',
      );
    }
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) updates.name = patch.name;
  if (patch.description !== undefined) updates.description = patch.description;
  if (patch.skillMd !== undefined) {
    updates.skillMd = patch.skillMd;
    updates.prompt = patch.skillMd;
  }
  if (patch.target !== undefined) updates.target = patch.target;
  const normalizedFiles = patch.files !== undefined ? normalizeSkillFiles(patch.files) : undefined;
  if (normalizedFiles !== undefined) updates.files = normalizedFiles;
  if (patch.localGuide !== undefined) updates.localGuide = patch.localGuide;
  if (patch.skillMd !== undefined || patch.files !== undefined) {
    const canonicalSkillMd = patch.skillMd ?? existing.skillMd ?? existing.prompt;
    if (patch.skillMd === undefined && existing.skillMd === null) {
      updates.skillMd = canonicalSkillMd;
      updates.prompt = canonicalSkillMd;
    }
    updates.contentHash = hashSkillBody(canonicalSkillMd, normalizedFiles ?? existing.files);
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
 * Copy a global skill template into a new project-scoped skill of the same name
 * (Skill Studio "apply default", ISS-388). The project skill then SHADOWS the
 * global for this project. Caller validates that `global` is a global skill and
 * authorizes owner/admin; this enforces the one-shadow-per-name rule.
 */
export async function applyGlobalSkillDefault(input: {
  projectId: string;
  global: {
    name: string;
    description: string;
    skillMd: string | null;
    prompt: string;
    target: SkillTarget | null;
    files: unknown;
  };
}): Promise<SkillRow> {
  const { projectId, global } = input;
  const [existing] = await db
    .select({ id: skills.id })
    .from(skills)
    .where(
      and(
        eq(skills.scope, 'project'),
        eq(skills.projectId, projectId),
        eq(skills.name, global.name),
      ),
    )
    .limit(1);
  if (existing) {
    throw new SkillAlreadyShadowedError(global.name);
  }
  const files = (Array.isArray(global.files) ? global.files : []) as SkillFileInput[];
  return createProjectSkill({
    projectId,
    name: global.name,
    description: global.description,
    skillMd: global.skillMd ?? global.prompt ?? '',
    target: global.target,
    files,
  });
}

export class SkillAlreadyShadowedError extends Error {
  readonly code = 'ALREADY_SHADOWED';
  constructor(name: string) {
    super(`ALREADY_SHADOWED: a project skill named '${name}' already exists`);
    this.name = 'SkillAlreadyShadowedError';
  }
}

/**
 * Single-path bridge for provisioning flows (project bootstrap, domain-template
 * apply): return the id of the project skill named `skillName`, cloning the
 * same-name global TEMPLATE into the project when the project does not own one
 * yet. Returns null when neither a project skill nor a global template of that
 * name exists (the caller decides whether to skip or error). Idempotent — a
 * re-run returns the existing project skill instead of cloning again.
 *
 * This is how a global enters a project under the single-path model: choosing a
 * skill for a stage materialises a project-owned copy; the global itself is
 * never registered or dispatched. See docs/skills-scope-playbook.md.
 */
export async function resolveOrAdoptProjectSkill(
  projectId: string,
  skillName: string,
): Promise<string | null> {
  const [proj] = await db
    .select({ id: skills.id })
    .from(skills)
    .where(
      and(eq(skills.scope, 'project'), eq(skills.projectId, projectId), eq(skills.name, skillName)),
    )
    .limit(1);
  if (proj) return proj.id;

  const [global] = await db
    .select({
      name: skills.name,
      description: skills.description,
      skillMd: skills.skillMd,
      prompt: skills.prompt,
      target: skills.target,
      files: skills.files,
    })
    .from(skills)
    .where(and(eq(skills.scope, 'global'), eq(skills.name, skillName)))
    .limit(1);
  if (!global) return null;

  const created = await createProjectSkill({
    projectId,
    name: global.name,
    description: global.description,
    skillMd: global.skillMd ?? global.prompt ?? '',
    target: global.target,
    files: (Array.isArray(global.files) ? global.files : []) as SkillFileInput[],
  });
  return created.id;
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
