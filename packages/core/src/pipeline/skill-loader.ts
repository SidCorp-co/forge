/**
 * ISS-105 — single source of truth for "is `forge-<type>` loadable right now?".
 *
 * The pipeline orchestrator calls this BEFORE inserting a `jobs` row. If it
 * comes back not-loadable, the orchestrator escalates the issue to
 * `pipeline_failed` instead of silently dispatching a job whose slash command
 * Claude CLI will treat as plain prompt text (exits in <1s, 0 tool calls).
 *
 * Resolution mirrors the effective-skill merge in
 * `packages/core/src/skills/override-routes.ts` (lines 119–149): a project
 * override wins over the global row, an empty override is treated as an
 * intentional disable (returns `skill_empty_body`).
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projectSkillOverrides, skills } from '../db/schema.js';

export type SkillResolution =
  | { loadable: true; source: 'project_override' | 'global'; contentHash: string }
  | {
      loadable: false;
      reason: 'skill_not_found' | 'skill_empty_body';
      skillName: string;
      expectedPath: string;
    };

export class SkillNotLoadableError extends Error {
  constructor(
    public readonly skillName: string,
    public readonly reason: 'skill_not_found' | 'skill_empty_body',
    public readonly expectedPath: string,
  ) {
    super(`skill ${skillName} not loadable: ${reason}`);
    this.name = 'SkillNotLoadableError';
  }
}

function expectedPathFor(skillName: string): string {
  return `packages/core/skills/${skillName}/SKILL.md`;
}

export async function resolveSkill(
  skillName: string,
  projectId: string,
): Promise<SkillResolution> {
  const [global] = await db
    .select({
      id: skills.id,
      skillMd: skills.skillMd,
      prompt: skills.prompt,
      contentHash: skills.contentHash,
    })
    .from(skills)
    .where(and(eq(skills.name, skillName), eq(skills.scope, 'global')))
    .limit(1);

  if (!global) {
    return {
      loadable: false,
      reason: 'skill_not_found',
      skillName,
      expectedPath: expectedPathFor(skillName),
    };
  }

  const [override] = await db
    .select({
      skillMdOverride: projectSkillOverrides.skillMdOverride,
      contentHash: projectSkillOverrides.contentHash,
    })
    .from(projectSkillOverrides)
    .where(
      and(
        eq(projectSkillOverrides.projectId, projectId),
        eq(projectSkillOverrides.skillId, global.id),
      ),
    )
    .limit(1);

  if (override) {
    // An empty override is treated as an intentional disable, NOT a fallback
    // to global — surfacing `skill_empty_body` means an operator who blanked
    // the override on purpose still gets a clear failure surface instead of
    // the silent zero-work fail this whole module exists to prevent.
    if (!override.skillMdOverride || override.skillMdOverride.trim().length === 0) {
      return {
        loadable: false,
        reason: 'skill_empty_body',
        skillName,
        expectedPath: expectedPathFor(skillName),
      };
    }
    return { loadable: true, source: 'project_override', contentHash: override.contentHash };
  }

  // Global body — legacy rows only have `prompt` populated (skillMd NULL).
  // The desktop runner skips empty bodies during sync (skill-sync.ts:128),
  // so treat the same gate here.
  const body = global.skillMd ?? global.prompt ?? '';
  if (body.trim().length === 0) {
    return {
      loadable: false,
      reason: 'skill_empty_body',
      skillName,
      expectedPath: expectedPathFor(skillName),
    };
  }
  return { loadable: true, source: 'global', contentHash: global.contentHash };
}

export async function assertSkillLoadable(
  skillName: string,
  projectId: string,
): Promise<void> {
  const r = await resolveSkill(skillName, projectId);
  if (!r.loadable) {
    throw new SkillNotLoadableError(r.skillName, r.reason, r.expectedPath);
  }
}
