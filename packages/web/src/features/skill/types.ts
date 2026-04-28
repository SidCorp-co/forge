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

// EPIC 6 (ISS-278/290) — per-project skill override response shape from
// /api/projects/:projectId/skills/effective. The list merges global skills
// with their project-specific overrides; `isOverridden` flags rows where the
// project's `skill_md_override` replaces the global `skill_md`.
export interface EffectiveSkill extends Skill {
  isOverridden: boolean;
  globalSkillId?: string;
  globalContentHash?: string | null;
  globalSkillMd?: string | null;
}

export interface SkillOverride {
  id: string;
  projectId: string;
  skillId: string;
  skillMdOverride: string;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
}
