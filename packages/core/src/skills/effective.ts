import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { skills } from '../db/schema.js';
import { hashSkillBody } from './hash.js';

export interface SkillFile {
  path: string;
  content: string;
  encoding: 'utf8' | 'base64';
}

interface EffectiveSkill {
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
interface SkillBodyRow {
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

function computeEffectiveSkill(skill: SkillBodyRow): EffectiveSkill {
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

export async function resolveRegisteredEffectiveSkills(
  projectId: string,
): Promise<EffectiveSkill[]> {
  const rows = (await db
    .select(skillBodyProjection)
    .from(skills)
    .where(
      and(
        eq(skills.scope, 'project'),
        eq(skills.projectId, projectId),
        eq(skills.installOnly, true),
      ),
    )) as SkillBodyRow[];
  return rows.map(computeEffectiveSkill);
}

export const MANAGED_META_SKILLS: readonly string[] = ['forge-skills', 'forge-message-shape'];

interface ManagedMetaPrompt {
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
