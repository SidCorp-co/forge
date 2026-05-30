import { and, eq, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { deviceSkills, projectSkillOverrides, skillRegistrations, skills } from '../db/schema.js';
import { hashSkillBody } from './hash.js';

/**
 * Shared, override-aware effective-skill resolution for Skill Studio 4
 * (ISS-278). The web-facing `/skills/effective` endpoint
 * (`override-routes.ts`) keeps its own response shape; this module is the
 * single source of truth for the **device sync manifest**, which must hash
 * uniformly via `hashSkillBody(effectiveMd, files)` for every entry —
 * including overridden globals (the override row's own `contentHash` omits
 * `files`, so it cannot be trusted for freshness).
 */

export interface SkillFile {
  path: string;
  content: string;
  encoding: 'utf8' | 'base64';
}

export interface EffectiveSkill {
  skillId: string;
  name: string;
  version: number;
  skillMd: string;
  files: SkillFile[];
  effectiveHash: string;
  isOverridden: boolean;
}

/** The skill columns the resolver needs — a subset of the `skills` row. */
export interface SkillBodyRow {
  id: string;
  name: string;
  version: number;
  scope: 'global' | 'project';
  skillMd: string | null;
  prompt: string;
  files: unknown;
}

/**
 * Resolve the effective body + hash for one skill, applying a project
 * override when present. Pure — no DB access — so the merge/hash rules are
 * unit-testable in isolation.
 *
 * - Overrides apply to **global** skills only and carry markdown but no files,
 *   so the effective files always come from the base `skills.files`.
 * - Legacy skills (seeded pre-v0.1) have `skill_md = NULL` and only `prompt`
 *   populated; fall back to `prompt` so the device never installs a 0-byte
 *   SKILL.md.
 * - `effectiveHash` is ALWAYS recomputed from the effective body so it matches
 *   exactly what the runner echoes back as `installedHash`.
 */
export function computeEffectiveSkill(
  skill: SkillBodyRow,
  override: { skillMdOverride: string } | undefined,
): EffectiveSkill {
  const files = (Array.isArray(skill.files) ? skill.files : []) as SkillFile[];

  let md: string;
  let isOverridden = false;
  if (skill.scope === 'global' && override) {
    md = override.skillMdOverride;
    isOverridden = true;
  } else if (skill.skillMd != null && skill.skillMd.trim() !== '') {
    md = skill.skillMd;
  } else {
    md = skill.prompt ?? '';
  }

  return {
    skillId: skill.id,
    name: skill.name,
    version: skill.version,
    skillMd: md,
    files,
    effectiveHash: hashSkillBody(md, files),
    isOverridden,
  };
}

const skillBodyProjection = {
  id: skills.id,
  name: skills.name,
  version: skills.version,
  scope: skills.scope,
  skillMd: skills.skillMd,
  prompt: skills.prompt,
  files: skills.files,
} as const;

/**
 * Every skill visible to a project (its own project-scoped skills + all
 * globals), with overrides merged and the effective hash computed.
 */
export async function resolveEffectiveSkillsForProject(
  projectId: string,
): Promise<EffectiveSkill[]> {
  const rows = (await db
    .select(skillBodyProjection)
    .from(skills)
    .where(or(eq(skills.scope, 'global'), eq(skills.projectId, projectId)))) as SkillBodyRow[];

  const overrides = await db
    .select({
      skillId: projectSkillOverrides.skillId,
      skillMdOverride: projectSkillOverrides.skillMdOverride,
    })
    .from(projectSkillOverrides)
    .where(eq(projectSkillOverrides.projectId, projectId));

  const overrideBySkillId = new Map(overrides.map((o) => [o.skillId, o]));

  return rows.map((r) => computeEffectiveSkill(r, overrideBySkillId.get(r.id)));
}

/**
 * The device-sync manifest set: effective skills intersected with the skills
 * registered to ANY stage of the project. Scope is intentionally limited to
 * registered skills (expanding beyond that is out of scope for ISS-278).
 */
export async function resolveRegisteredEffectiveSkills(
  projectId: string,
): Promise<EffectiveSkill[]> {
  const regs = await db
    .select({ skillId: skillRegistrations.skillId })
    .from(skillRegistrations)
    .where(eq(skillRegistrations.projectId, projectId));

  const registeredIds = new Set(regs.map((r) => r.skillId));
  if (registeredIds.size === 0) return [];

  const all = await resolveEffectiveSkillsForProject(projectId);
  return all.filter((s) => registeredIds.has(s.skillId));
}

export type DeviceSkillStatusValue = 'synced' | 'outdated' | 'missing';

export interface DeviceSkillStatusEntry {
  skillId: string;
  name: string;
  effectiveHash: string;
  installedHash: string | null;
  installedVersion: number | null;
  syncedAt: string | null;
  status: DeviceSkillStatusValue;
}

interface InstalledRow {
  skillId: string;
  installedHash: string;
  installedVersion: number | null;
  syncedAt: Date | string | null;
}

/**
 * Per-skill freshness for one device: `missing` (no install row), `outdated`
 * (installed hash differs from effective hash), or `synced` (equal). Pure so
 * the status logic is unit-testable without a DB.
 */
export function computeDeviceSkillStatus(
  effective: EffectiveSkill[],
  installed: InstalledRow[],
): DeviceSkillStatusEntry[] {
  const byId = new Map(installed.map((i) => [i.skillId, i]));
  return effective.map((e) => {
    const row = byId.get(e.skillId);
    let status: DeviceSkillStatusValue;
    if (!row) status = 'missing';
    else if (row.installedHash !== e.effectiveHash) status = 'outdated';
    else status = 'synced';

    const syncedAt = row?.syncedAt ?? null;
    return {
      skillId: e.skillId,
      name: e.name,
      effectiveHash: e.effectiveHash,
      installedHash: row?.installedHash ?? null,
      installedVersion: row?.installedVersion ?? null,
      syncedAt: syncedAt instanceof Date ? syncedAt.toISOString() : syncedAt,
      status,
    };
  });
}

/** Load the registered effective skills + this device's install rows and diff. */
export async function loadDeviceSkillStatus(
  projectId: string,
  deviceId: string,
): Promise<DeviceSkillStatusEntry[]> {
  const effective = await resolveRegisteredEffectiveSkills(projectId);
  const installed = (await db
    .select({
      skillId: deviceSkills.skillId,
      installedHash: deviceSkills.installedHash,
      installedVersion: deviceSkills.installedVersion,
      syncedAt: deviceSkills.syncedAt,
    })
    .from(deviceSkills)
    .where(
      and(eq(deviceSkills.deviceId, deviceId), eq(deviceSkills.projectId, projectId)),
    )) as InstalledRow[];

  return computeDeviceSkillStatus(effective, installed);
}
