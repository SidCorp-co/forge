import { and, eq, isNotNull, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects, runners, type SkillTarget, skills } from '../db/schema.js';
import { logger } from '../logger.js';
import { hooks } from '../pipeline/hooks.js';
import { SkillContentBlockedError } from '../security/findings.js';
import { scanSkillContent } from '../security/skill-content-scanner.js';
import { hashSkillBody } from './hash.js';
import { assertSkillNameWritable } from './lock-context.js';
import { isMetaSkillName, MetaSkillReservedError } from './meta-skills.js';

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
  installOnly?: boolean;
  /** ISS-605 template lineage (null = not adopted from a template / pre-tracking). */
  basedOnGlobalSkillId?: string | null;
  basedOnGlobalVersion?: number | null;
  /** ISS-802 — intentional, permanent divergence; see `PUT /api/projects/:projectId/skills/:skillId/pin`. */
  pinned?: boolean;
  pinnedReason?: string | null;
  pinnedBy?: string | null;
  pinnedAt?: Date | string | null;
};

export const skillProjection = {
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
  installOnly: skills.installOnly,
  basedOnGlobalSkillId: skills.basedOnGlobalSkillId,
  basedOnGlobalVersion: skills.basedOnGlobalVersion,
  pinned: skills.pinned,
  pinnedReason: skills.pinnedReason,
  pinnedBy: skills.pinnedBy,
  pinnedAt: skills.pinnedAt,
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
  /** ISS-605 template lineage — set when the skill is adopted from a global. */
  basedOnGlobalSkillId?: string | undefined;
  basedOnGlobalVersion?: number | undefined;
  /**
   * ISS-741 — bypass the reserved meta-skill-name guard. Only the SYSTEM
   * provisioning bridge (`resolveOrAdoptProjectSkill`, used by the
   * `install_only` bootstrap fan-out + domain-template apply) may set this;
   * a user-facing create/adopt path must never pass true.
   */
  allowReservedMetaName?: boolean | undefined;
}

export async function createProjectSkill(input: CreateProjectSkillInput): Promise<SkillRow> {
  if (!input.allowReservedMetaName) await assertSkillNameWritable(input.name, input.projectId);

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
      basedOnGlobalSkillId: input.basedOnGlobalSkillId ?? null,
      basedOnGlobalVersion: input.basedOnGlobalVersion ?? null,
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
  installOnly?: boolean | undefined;
  /**
   * ISS-679 — set true after reconciling the copy with its global template:
   * restamps `basedOnGlobalVersion` to the template's CURRENT version so
   * `behindTemplate` clears and the template-propagation sweep stops
   * re-drafting rebase issues. Deliberately opt-in — an ordinary local edit
   * must NOT claim template reconciliation it never did.
   */
  markRebased?: boolean | undefined;
}

/**
 * Apply a partial update to a project skill. `existing` is the current row
 * (fetched + authorized by the caller). Bumps `version` + recomputes
 * `contentHash` whenever the body (skillMd) or files change; backfills the
 * canonical `skillMd` for legacy prompt-only rows on first edit. A
 * `markRebased`-only call stamps `basedOnGlobalVersion` without a version
 * bump (metadata, not content).
 */
export async function updateProjectSkill(
  existing: Pick<
    SkillRow,
    'id' | 'skillMd' | 'prompt' | 'files' | 'version' | 'name' | 'description'
  > &
    Partial<Pick<SkillRow, 'basedOnGlobalSkillId'>>,
  patch: UpdateProjectSkillPatch,
): Promise<SkillRow> {
  if (patch.name !== undefined && patch.name !== existing.name && isMetaSkillName(patch.name)) {
    throw new MetaSkillReservedError(patch.name);
  }

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
  if (patch.installOnly !== undefined) updates.installOnly = patch.installOnly;
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
  if (patch.markRebased) {
    if (!existing.basedOnGlobalSkillId) {
      throw new Error(
        'BAD_REQUEST: markRebased requires a skill linked to a global template (basedOnGlobalSkillId is null)',
      );
    }
    const [globalRow] = await db
      .select({ version: skills.version })
      .from(skills)
      .where(eq(skills.id, existing.basedOnGlobalSkillId))
      .limit(1);
    if (!globalRow) throw new Error('NOT_FOUND: linked global template not found');
    updates.basedOnGlobalVersion = globalRow.version ?? 1;
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
    id: string;
    version: number;
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
    basedOnGlobalSkillId: global.id,
    basedOnGlobalVersion: global.version,
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
 * never registered or dispatched.
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
      id: skills.id,
      version: skills.version,
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
    basedOnGlobalSkillId: global.id,
    basedOnGlobalVersion: global.version,
    // ISS-741 — this is the SYSTEM provisioning bridge (bootstrap fan-out +
    // domain-template apply), not a user create/adopt path; it must keep
    // delivering forge-onboard's disk copy until ISS-742 retires it.
    allowReservedMetaName: true,
  });
  return created.id;
}

/**
 * Resolve a project's runners to a distinct set of device ids, optionally
 * narrowed to one device.
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
