import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { deviceSkills, devices, runners, skillRegistrations, skills } from '../db/schema.js';
import { hashSkillBody } from './hash.js';

export interface SkillFile {
  path: string;
  content: string;
  encoding: 'utf8' | 'base64';
}

export interface EffectiveSkill {
  skillId: string;
  name: string;
  /**
   * The author's one-line summary (`skills.description`, NOT NULL in the DB).
   * Carried so a caller that lists skills for a human — the chat composer's
   * slash menu (ISS-718) — can label them without loading `skillMd`. Outside
   * `effectiveHash` on purpose: rewording a description must not re-sync every
   * runner's installed copy.
   */
  description: string;
  version: number;
  skillMd: string;
  files: SkillFile[];
  effectiveHash: string;
  /**
   * The skill's scope. Only `project` is USABLE (installed/dispatched); a
   * `global` entry only ever appears in the catalog read as an adoptable
   * template.
   */
  scope: 'global' | 'project';
  /**
   * Catalog hint only: true when a same-name global template exists. NEVER a
   * resolution rule — a global never falls back into the usable set.
   */
  shadowsGlobal: boolean;
  /** The same-name global's skill id (null when none). Catalog hint only. */
  shadowedGlobalSkillId: string | null;
  basedOnGlobalVersion: number | null;
  templateVersion: number | null;
  /**
   * ISS-802: intentional, permanent divergence from the template. Globals and
   * unshadowed rows carry `false`/`null`.
   */
  pinned: boolean;
  pinnedReason: string | null;
  /**
   * True when this project skill is force-synced to runners without a pipeline
   * stage binding (manual / user-invocable utility). It enters the device
   * manifest but is never auto-dispatched. See `resolveRegisteredEffectiveSkills`.
   */
  installOnly: boolean;
}

/** The skill columns the resolver needs — a subset of the `skills` row. */
export interface SkillBodyRow {
  id: string;
  name: string;
  /** Optional so the pure helpers still accept legacy/partial fixtures. */
  description?: string | null;
  version: number;
  scope: 'global' | 'project';
  skillMd: string | null;
  prompt: string;
  files: unknown;
  installOnly: boolean;
  basedOnGlobalVersion?: number | null;
  pinned?: boolean;
  pinnedReason?: string | null;
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

export function computeEffectiveSkill(skill: SkillBodyRow): EffectiveSkill {
  const files = (Array.isArray(skill.files) ? skill.files : []) as SkillFile[];
  const md = globalEffectiveMd(skill);

  return {
    skillId: skill.id,
    name: skill.name,
    description: skill.description ?? '',
    version: skill.version,
    skillMd: md,
    files,
    effectiveHash: hashSkillBody(md, files),
    scope: skill.scope,
    shadowsGlobal: false,
    shadowedGlobalSkillId: null,
    basedOnGlobalVersion: null,
    templateVersion: null,
    pinned: skill.pinned ?? false,
    pinnedReason: skill.pinnedReason ?? null,
    installOnly: skill.installOnly,
  };
}

const skillBodyProjection = {
  id: skills.id,
  name: skills.name,
  description: skills.description,
  version: skills.version,
  scope: skills.scope,
  skillMd: skills.skillMd,
  prompt: skills.prompt,
  files: skills.files,
  installOnly: skills.installOnly,
  basedOnGlobalVersion: skills.basedOnGlobalVersion,
  pinned: skills.pinned,
  pinnedReason: skills.pinnedReason,
} as const;

/**
 * Dedup raw skill rows by NAME — a project-scoped skill shadows the same-name
 * global template (project wins, one row per name). Pure (no DB) so the dedup
 * rule is unit-testable in isolation. A project skill that shadows a global
 * carries `shadowsGlobal=true` + the shadowed global's id; a global that is
 * shadowed is dropped; everything else is unflagged.
 */
export function dedupEffectiveSkills(rows: SkillBodyRow[]): EffectiveSkill[] {
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
    eff.basedOnGlobalVersion = r.basedOnGlobalVersion ?? null;
    eff.templateVersion = shadowed?.version ?? null;
    eff.pinned = r.pinned ?? false;
    eff.pinnedReason = r.pinnedReason ?? null;
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

async function resolveRawEffectiveSkillsForProject(projectId: string): Promise<EffectiveSkill[]> {
  const rows = (await db
    .select(skillBodyProjection)
    .from(skills)
    .where(or(eq(skills.scope, 'global'), eq(skills.projectId, projectId)))) as SkillBodyRow[];

  return dedupEffectiveSkills(rows);
}

export async function resolveEffectiveSkillsForProject(
  projectId: string,
): Promise<EffectiveSkill[]> {
  return resolveRawEffectiveSkillsForProject(projectId);
}

export async function resolveRegisteredEffectiveSkills(
  projectId: string,
): Promise<EffectiveSkill[]> {
  const regs = await db
    .select({ skillId: skillRegistrations.skillId })
    .from(skillRegistrations)
    .where(eq(skillRegistrations.projectId, projectId));

  const registeredIds = [...new Set(regs.map((r) => r.skillId))];
  let registeredNames = new Set<string>();
  if (registeredIds.length > 0) {
    const nameRows = await db
      .select({ name: skills.name })
      .from(skills)
      .where(inArray(skills.id, registeredIds));
    registeredNames = new Set(nameRows.map((n) => n.name));
  }

  const nameCondition =
    registeredNames.size > 0
      ? or(inArray(skills.name, [...registeredNames]), eq(skills.installOnly, true))
      : eq(skills.installOnly, true);
  const rows = (await db
    .select(skillBodyProjection)
    .from(skills)
    .where(
      and(eq(skills.scope, 'project'), eq(skills.projectId, projectId), nameCondition),
    )) as SkillBodyRow[];
  return rows.map(computeEffectiveSkill);
}

export const MANAGED_META_SKILLS: readonly string[] = ['forge-skills', 'forge-message-shape'];

export interface ManagedMetaPrompt {
  name: string;
  description: string;
  body: string;
}

/**
 * The managed-meta skills as MCP PROMPTS — served live from Forge MCP so any
 * session connected to the Forge MCP server gets the current meta guidance with
 * zero disk sync (the always-latest channel; complements the disk install).
 * Resolves the project's adopted copy if it exists, else the global template.
 * `projectId === null` (no project header) → the global bodies.
 */
export async function resolveManagedMetaPrompts(
  projectId: string | null,
): Promise<ManagedMetaPrompt[]> {
  if (MANAGED_META_SKILLS.length === 0) return [];
  const names = [...MANAGED_META_SKILLS];
  const scopeCond = projectId
    ? or(
        eq(skills.scope, 'global'),
        and(eq(skills.scope, 'project'), eq(skills.projectId, projectId)),
      )
    : eq(skills.scope, 'global');
  const rows = await db
    .select({
      name: skills.name,
      description: skills.description,
      scope: skills.scope,
      skillMd: skills.skillMd,
      prompt: skills.prompt,
    })
    .from(skills)
    .where(and(inArray(skills.name, names), scopeCond));

  const byName = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const cur = byName.get(r.name);
    if (!cur || (r.scope === 'project' && cur.scope === 'global')) byName.set(r.name, r);
  }
  return [...byName.values()].map((r) => ({
    name: r.name,
    description: r.description ?? '',
    body: globalEffectiveMd(r),
  }));
}

export type DeviceSkillStatusValue =
  | 'synced'
  | 'outdated'
  | 'missing'
  | 'unknown'
  | 'shadowed'
  | 'stale';

export interface DeviceSkillStatusEntry {
  skillId: string;
  name: string;
  effectiveHash: string;
  installedHash: string | null;
  installedVersion: number | null;
  syncedAt: string | null;
  observedSha: string | null;
  shadowedBy: string | null;
  status: DeviceSkillStatusValue;
}

interface InstalledRow {
  skillId: string;
  installedHash: string;
  installedVersion: number | null;
  syncedAt: Date | string | null;
  observedSha: string | null;
  shadowedBy: string | null;
}

/**
 * Per-skill freshness for one device. Observation-aware (ISS-798): when the
 * runner sends `observed_sha`, that field (not just the echoed installed_hash)
 * determines the status — so a shadow copy can be surfaced as `shadowed`
 * instead of silently appearing `synced`. Pure so the status logic is
 * unit-testable without a DB.
 */
export function computeDeviceSkillStatus(
  effective: EffectiveSkill[],
  installed: InstalledRow[],
): DeviceSkillStatusEntry[] {
  const byId = new Map(installed.map((i) => [i.skillId, i]));
  return effective.map((e) => {
    const row = byId.get(e.skillId);
    let status: DeviceSkillStatusValue;
    if (!row) {
      status = 'missing';
    } else if (row.installedHash !== e.effectiveHash) {
      status = 'outdated';
    } else if (row.shadowedBy !== null) {
      status = 'shadowed';
    } else if (row.observedSha === null) {
      status = 'unknown';
    } else if (row.observedSha !== row.installedHash) {
      status = 'stale';
    } else {
      status = 'synced';
    }

    const syncedAt = row?.syncedAt ?? null;
    return {
      skillId: e.skillId,
      name: e.name,
      effectiveHash: e.effectiveHash,
      installedHash: row?.installedHash ?? null,
      installedVersion: row?.installedVersion ?? null,
      syncedAt: syncedAt instanceof Date ? syncedAt.toISOString() : syncedAt,
      observedSha: row?.observedSha ?? null,
      shadowedBy: row?.shadowedBy ?? null,
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
      observedSha: deviceSkills.observedSha,
      shadowedBy: deviceSkills.shadowedBy,
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
      observedSha: deviceSkills.observedSha,
      shadowedBy: deviceSkills.shadowedBy,
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
