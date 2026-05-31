import { and, eq, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  deviceSkills,
  devices,
  projectSkillOverrides,
  runners,
  skillRegistrations,
  skills,
} from '../db/schema.js';
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
 * The effective markdown body for a skill ignoring overrides: `skill_md` when
 * present, else the legacy `prompt` fallback (skills seeded pre-v0.1 have
 * `skill_md = NULL`). Shared so the override route and the resolver derive the
 * global body identically.
 */
export function globalEffectiveMd(skill: { skillMd: string | null; prompt: string | null }): string {
  if (skill.skillMd != null && skill.skillMd.trim() !== '') return skill.skillMd;
  return skill.prompt ?? '';
}

/**
 * The current effective hash of a global skill's folder (`md + files`). This is
 * the single source of truth for the fork-time `globalContentHash` snapshot AND
 * for the live drift comparison, so the two never diverge in how they hash
 * legacy (`prompt`-only) skills.
 */
export function globalEffectiveHash(skill: {
  skillMd: string | null;
  prompt: string | null;
  files: unknown;
}): string {
  return hashSkillBody(globalEffectiveMd(skill), skill.files);
}

/**
 * Resolve the effective body + hash for one skill, applying a project
 * override when present. Pure — no DB access — so the merge/hash rules are
 * unit-testable in isolation.
 *
 * - Overrides apply to **global** skills only and now fork the whole folder:
 *   the effective files come from the override's `files`, falling back to the
 *   base `skills.files` when the override carries none (legacy markdown-only
 *   rows backfilled with `files = []`).
 * - Legacy skills (seeded pre-v0.1) have `skill_md = NULL` and only `prompt`
 *   populated; fall back to `prompt` so the device never installs a 0-byte
 *   SKILL.md.
 * - `effectiveHash` is ALWAYS recomputed from the effective body so it matches
 *   exactly what the runner echoes back as `installedHash`.
 */
export function computeEffectiveSkill(
  skill: SkillBodyRow,
  override: { skillMdOverride: string; files?: unknown } | undefined,
): EffectiveSkill {
  const baseFiles = (Array.isArray(skill.files) ? skill.files : []) as SkillFile[];

  let md: string;
  let files: SkillFile[];
  let isOverridden = false;
  if (skill.scope === 'global' && override) {
    md = override.skillMdOverride;
    const overrideFiles = (Array.isArray(override.files) ? override.files : []) as SkillFile[];
    files = overrideFiles.length > 0 ? overrideFiles : baseFiles;
    isOverridden = true;
  } else {
    files = baseFiles;
    md = globalEffectiveMd(skill);
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
      files: projectSkillOverrides.files,
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

// ── Skill Studio 5 (ISS-279) — aggregated, skill-major sync status ──────────
// Studio is a by-skill surface: it needs every project-bound device × every
// registered skill in one read. The per-device endpoint above stays for the
// device-centric page; this one pivots into a skill-major shape so the panel
// renders directly.

/** A project-bound device (a `claude-code` runner's device) for the sync UI. */
export interface SkillSyncDevice {
  deviceId: string;
  name: string;
  status: string;
  lastSeenAt: string | null;
}

/** One device's freshness for a single skill (skill-major nesting). */
export interface SkillDeviceSyncEntry {
  deviceId: string;
  status: DeviceSkillStatusValue;
  installedVersion: number | null;
  installedHash: string | null;
  syncedAt: string | null;
}

/** A registered skill with its per-device install status. */
export interface SkillSyncSkillEntry {
  skillId: string;
  name: string;
  currentVersion: number;
  effectiveHash: string;
  devices: SkillDeviceSyncEntry[];
}

export interface ProjectSkillSyncStatus {
  devices: SkillSyncDevice[];
  skills: SkillSyncSkillEntry[];
}

/**
 * Pivot per-device freshness into the skill-major shape Studio renders. Pure
 * (no DB) so the pivot is unit-testable. `installedByDevice` maps a deviceId to
 * that device's install rows; missing devices/skills fall through
 * `computeDeviceSkillStatus` to `missing`.
 */
export function pivotProjectSkillSyncStatus(
  deviceList: SkillSyncDevice[],
  effective: EffectiveSkill[],
  installedByDevice: Map<string, InstalledRow[]>,
): ProjectSkillSyncStatus {
  const statusByDevice = new Map<string, Map<string, DeviceSkillStatusEntry>>();
  for (const d of deviceList) {
    const entries = computeDeviceSkillStatus(effective, installedByDevice.get(d.deviceId) ?? []);
    statusByDevice.set(d.deviceId, new Map(entries.map((e) => [e.skillId, e])));
  }

  const skillEntries: SkillSyncSkillEntry[] = effective.map((e) => ({
    skillId: e.skillId,
    name: e.name,
    currentVersion: e.version,
    effectiveHash: e.effectiveHash,
    devices: deviceList.map((d) => {
      const entry = statusByDevice.get(d.deviceId)?.get(e.skillId);
      return {
        deviceId: d.deviceId,
        status: entry?.status ?? 'missing',
        installedVersion: entry?.installedVersion ?? null,
        installedHash: entry?.installedHash ?? null,
        syncedAt: entry?.syncedAt ?? null,
      };
    }),
  }));

  return { devices: deviceList, skills: skillEntries };
}

/**
 * Load the aggregated, skill-major sync status for a project: every bound
 * device (derived from the `runners` table) × every registered effective
 * skill, diffed against the real `device_skills` install rows. One pass over
 * the project's install rows, grouped by device, then pivoted.
 */
export async function loadProjectSkillSyncStatus(
  projectId: string,
): Promise<ProjectSkillSyncStatus> {
  // Bound devices = this project's claude-code runners joined to their device.
  // A device may back multiple runners — dedupe by deviceId, keeping the most
  // recently seen row's metadata.
  const runnerRows = await db
    .select({
      deviceId: devices.id,
      name: devices.name,
      status: devices.status,
      lastSeenAt: devices.lastSeenAt,
    })
    .from(runners)
    .innerJoin(devices, eq(runners.deviceId, devices.id))
    .where(and(eq(runners.projectId, projectId), eq(runners.type, 'claude-code')));

  const deviceById = new Map<string, SkillSyncDevice>();
  for (const r of runnerRows) {
    const lastSeenAt =
      r.lastSeenAt instanceof Date ? r.lastSeenAt.toISOString() : (r.lastSeenAt ?? null);
    const existing = deviceById.get(r.deviceId);
    if (!existing || (lastSeenAt && (!existing.lastSeenAt || lastSeenAt > existing.lastSeenAt))) {
      deviceById.set(r.deviceId, { deviceId: r.deviceId, name: r.name, status: r.status, lastSeenAt });
    }
  }
  const deviceList = [...deviceById.values()];

  const effective = await resolveRegisteredEffectiveSkills(projectId);

  const installedRows = (await db
    .select({
      deviceId: deviceSkills.deviceId,
      skillId: deviceSkills.skillId,
      installedHash: deviceSkills.installedHash,
      installedVersion: deviceSkills.installedVersion,
      syncedAt: deviceSkills.syncedAt,
    })
    .from(deviceSkills)
    .where(eq(deviceSkills.projectId, projectId))) as Array<InstalledRow & { deviceId: string }>;

  const installedByDevice = new Map<string, InstalledRow[]>();
  for (const row of installedRows) {
    const arr = installedByDevice.get(row.deviceId) ?? [];
    arr.push(row);
    installedByDevice.set(row.deviceId, arr);
  }

  return pivotProjectSkillSyncStatus(deviceList, effective, installedByDevice);
}
