import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  deviceSkills,
  devices,
  runners,
  skillRegistrations,
  skills,
} from '../db/schema.js';
import { hashSkillBody } from './hash.js';

/**
 * Shared effective-skill resolution for Skill Studio (ISS-278/388). Global
 * skills are immutable templates; the only per-project customization is a
 * project-scoped skill with the SAME NAME, which SHADOWS the same-name global.
 * This module dedups by name (project wins) and is the single source of truth
 * for the **device sync manifest**, which must hash uniformly via
 * `hashSkillBody(effectiveMd, files)` for every entry.
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
  /** True when this project skill shadows a same-name global template. */
  shadowsGlobal: boolean;
  /** The shadowed global's skill id (null when not shadowing). */
  shadowedGlobalSkillId: string | null;
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
export function globalEffectiveMd(skill: {
  skillMd: string | null;
  prompt: string | null;
}): string {
  if (skill.skillMd != null && skill.skillMd.trim() !== '') return skill.skillMd;
  return skill.prompt ?? '';
}

/**
 * Resolve the effective body + hash for one skill. Pure — no DB access — so the
 * hash rule is unit-testable in isolation.
 *
 * - Legacy skills (seeded pre-v0.1) have `skill_md = NULL` and only `prompt`
 *   populated; fall back to `prompt` so the device never installs a 0-byte
 *   SKILL.md.
 * - `effectiveHash` is ALWAYS recomputed from the effective body so it matches
 *   exactly what the runner echoes back as `installedHash`.
 *
 * Shadow fields default to "not shadowing"; `resolveRawEffectiveSkillsForProject`
 * sets them when a project skill shadows a same-name global.
 */
export function computeEffectiveSkill(skill: SkillBodyRow): EffectiveSkill {
  const files = (Array.isArray(skill.files) ? skill.files : []) as SkillFile[];
  const md = globalEffectiveMd(skill);

  return {
    skillId: skill.id,
    name: skill.name,
    version: skill.version,
    skillMd: md,
    files,
    effectiveHash: hashSkillBody(md, files),
    shadowsGlobal: false,
    shadowedGlobalSkillId: null,
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
 * Dedup raw skill rows by NAME — a project-scoped skill shadows the same-name
 * global template (project wins, one row per name). Pure (no DB) so the dedup
 * rule is unit-testable in isolation. A project skill that shadows a global
 * carries `shadowsGlobal=true` + the shadowed global's id; a global that is
 * shadowed is dropped; everything else is unflagged.
 */
export function dedupEffectiveSkills(rows: SkillBodyRow[]): EffectiveSkill[] {
  // Index globals by name so a same-name project skill can shadow them.
  const globalByName = new Map<string, SkillBodyRow>();
  for (const r of rows) if (r.scope === 'global') globalByName.set(r.name, r);

  const result: EffectiveSkill[] = [];
  const shadowedNames = new Set<string>();

  // Project skills win. Each marks the same-name global (if any) as shadowed.
  for (const r of rows) {
    if (r.scope !== 'project') continue;
    shadowedNames.add(r.name);
    const shadowed = globalByName.get(r.name);
    const eff = computeEffectiveSkill(r);
    eff.shadowsGlobal = shadowed != null;
    eff.shadowedGlobalSkillId = shadowed?.id ?? null;
    result.push(eff);
  }

  // Globals NOT shadowed by a same-name project skill.
  for (const r of rows) {
    if (r.scope !== 'global') continue;
    if (shadowedNames.has(r.name)) continue;
    result.push(computeEffectiveSkill(r));
  }

  return result;
}

/** Raw effective skills, deduped by NAME (project shadows same-name global).
 *  Used internally so the two public resolvers expand with the right per-skill
 *  stage context. */
async function resolveRawEffectiveSkillsForProject(projectId: string): Promise<EffectiveSkill[]> {
  const rows = (await db
    .select(skillBodyProjection)
    .from(skills)
    .where(or(eq(skills.scope, 'global'), eq(skills.projectId, projectId)))) as SkillBodyRow[];

  return dedupEffectiveSkills(rows);
}

/**
 * Every skill visible to a project (its own project-scoped skills + all
 * globals), deduped by name (project shadows same-name global) with the
 * effective hash computed. Skill bodies are NOT templated: Forge facts +
 * project context are injected into the system prompt at dispatch
 * (`prompt/system.ts`), so a synced SKILL.md is exactly what the author wrote —
 * no var expansion, no fact-driven re-sync churn.
 */
export async function resolveEffectiveSkillsForProject(
  projectId: string,
): Promise<EffectiveSkill[]> {
  return resolveRawEffectiveSkillsForProject(projectId);
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

  const registeredIds = [...new Set(regs.map((r) => r.skillId))];
  if (registeredIds.length === 0) return [];

  // Filter by NAME, not skillId: a registration may point at a global that is
  // now shadowed by a same-name project skill. The deduped list carries the
  // project skill's id under that name, so matching by id would drop the
  // shadow. Resolve registered ids → names, then keep effective rows by name.
  const nameRows = await db
    .select({ name: skills.name })
    .from(skills)
    .where(inArray(skills.id, registeredIds));
  const registeredNames = new Set(nameRows.map((n) => n.name));
  if (registeredNames.size === 0) return [];

  const all = await resolveRawEffectiveSkillsForProject(projectId);
  return all.filter((s) => registeredNames.has(s.name));
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
      deviceById.set(r.deviceId, {
        deviceId: r.deviceId,
        name: r.name,
        status: r.status,
        lastSeenAt,
      });
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
