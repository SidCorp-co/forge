export interface Skill {
  id: string;
  name: string;
  description: string;
  scope: 'global' | 'project';
  projectId: string | null;
  prompt: string;
  tools: string[];
  manifest: Record<string, unknown>;
  source: 'builtin' | 'user';
  version: number;
  contentHash: string | null;
  evalScore: number | null;
  skillMd: string | null;
  target: 'dev' | 'cloud' | 'all' | null;
  files: SkillFile[];
  changelog: ChangelogEntry[];
  localGuide: string | null;
  isGlobal?: boolean;
  // Legacy Strapi-shape aliases — TODO drop once consumers migrate.
  documentId?: string;
  project?: { documentId: string };
  createdAt: string;
  updatedAt: string;
}

export interface SkillFile {
  path: string;
  content: string;
  encoding: 'utf8' | 'base64';
}

export interface ChangelogEntry {
  version: string;
  hash: string;
  timestamp: string;
  summary: string;
}

export interface SkillSyncStatus {
  skillId: string;
  skillName: string;
  target: 'dev' | 'cloud' | 'all' | null;
  scope: 'global' | 'project';
  currentHash: string | null;
  currentVersion: number;
  updatedAt: string;
  registeredStages: string[];
  // Legacy field — devices breakdown not yet ported from Strapi. Empty array.
  devices?: Array<{ deviceId: string; inSync: boolean }>;
  isGlobal?: boolean;
}

export interface BulkPushResult {
  target: string;
  status: string;
  jobId: string | null;
  error?: string;
}

// Skill Studio 5 (ISS-279) — aggregated, skill-major per-device freshness from
// GET /api/projects/:projectId/skill-sync-status. Replaces the legacy empty
// `devices` stub on SkillSyncStatus; sourced from the real `device_skills`.
export type DeviceSkillSyncState = 'synced' | 'outdated' | 'missing';

export interface SkillSyncDevice {
  deviceId: string;
  name: string;
  status: string;
  lastSeenAt: string | null;
}

export interface SkillDeviceStatus {
  deviceId: string;
  status: DeviceSkillSyncState;
  installedVersion: number | null;
  installedHash: string | null;
  syncedAt: string | null;
}

export interface SkillSyncSkillEntry {
  skillId: string;
  name: string;
  currentVersion: number;
  effectiveHash: string;
  devices: SkillDeviceStatus[];
}

export interface ProjectSkillSyncStatus {
  devices: SkillSyncDevice[];
  skills: SkillSyncSkillEntry[];
}

// Per-device endpoint shape: GET /api/projects/:projectId/devices/:deviceId/skills
export interface DeviceSkillStatusEntry {
  skillId: string;
  name: string;
  effectiveHash: string;
  installedHash: string | null;
  installedVersion: number | null;
  syncedAt: string | null;
  status: DeviceSkillSyncState;
}

// ISS-388 — Skill Studio listing response from
// /api/projects/:projectId/skills/effective. Globals (read-only templates) +
// this project's project skills, NOT deduped. `editable` is true for project
// skills; the shadow relation links a project skill to the same-name global it
// shadows (`shadowsGlobal` + `shadowedGlobalSkillId`) and a global to the
// project skill shadowing it (`shadowedByProjectSkillId`).
export interface EffectiveSkill extends Skill {
  editable: boolean;
  shadowsGlobal?: boolean;
  shadowedGlobalSkillId?: string | null;
  shadowedByProjectSkillId?: string | null;
}
