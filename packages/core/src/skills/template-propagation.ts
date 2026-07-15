import { and, eq, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, projects, skills } from '../db/schema.js';
import { logger } from '../logger.js';

/**
 * ISS-605 — template-propagation protocol, step 3 (the rebase lane).
 *
 * Global skills are catalog TEMPLATES; every usable skill is a project COPY
 * frozen at adoption time (see effective.ts). When a template bumps, this
 * sweep finds every project copy adopted from it at an older (or unknown)
 * version and drafts ONE idempotent `skill-rebase` issue per project — the
 * human gate. Nothing is auto-applied and nothing auto-syncs to devices:
 * the drafted issue instructs a three-way merge that preserves the project's
 * own deltas, and the result ships through the EXISTING explicit skill.sync.
 *
 * Called from `seedBuiltinSkills` (the only path that bumps a global's
 * version — the CRUD update route rejects globals). Failures are logged and
 * swallowed: a sweep problem must never fail the seed/boot path.
 */

export interface TemplateBump {
  globalSkillId: string;
  name: string;
  oldVersion: number;
  newVersion: number;
}

export interface TemplateDriftSweepResult {
  /** Project copies found behind this template. */
  behind: number;
  /** Draft rebase issues actually created (idempotency may skip). */
  drafted: number;
  /** Projects skipped because a live skill-rebase issue already exists. */
  skipped: number;
}

const REBASE_TITLE_PREFIX = (skillName: string) => `skill-rebase: ${skillName} `;

function rebaseIssueDescription(bump: TemplateBump): string {
  return [
    '## Template update available',
    '',
    `Global skill template \`${bump.name}\` bumped **v${bump.oldVersion} → v${bump.newVersion}**. This project owns a copy adopted from an older (or untracked) version.`,
    '',
    '## Task — three-way rebase (NEVER overwrite)',
    '',
    `1. Fetch bodies: the project copy and the global template via \`forge_skills.list\` / \`forge_skills.get\` (template id \`${bump.globalSkillId}\`).`,
    `2. Compute what the template CHANGED (v${bump.oldVersion} → v${bump.newVersion}) and apply that delta onto the project copy, preserving every project-specific customization. When a template change conflicts with a project customization, keep the project behavior and note the conflict in a comment.`,
    '3. Altitude check: if a changed sentence is true for EVERY project (platform mechanics, memory/handoff discipline), do NOT port it into this skill body — it belongs in the server-rendered prompt facts; flag it in a comment instead.',
    '4. Post the resulting diff as an issue comment for review.',
    '5. On approval: update the project skill (`forge_skills.update`) passing `markRebased: true` — this restamps `basedOnGlobalVersion` to the template version so `behindTemplate` clears — then push to devices via the explicit sync (`forge_skills.push`).',
    '',
    '*Drafted automatically by the template-propagation sweep (ISS-605). Draft = human gate: move to `open` only when this rebase should actually run.*',
  ].join('\n');
}

/**
 * Sweep one template bump: flag + draft. Idempotent per (project, skill name)
 * — a project with ANY non-closed `skill-rebase: <name> …` issue is skipped,
 * so repeated bumps fold into the already-open rebase.
 */
export async function sweepTemplateDrift(bump: TemplateBump): Promise<TemplateDriftSweepResult> {
  const copies = await db
    .select({
      skillId: skills.id,
      projectId: skills.projectId,
      basedOnGlobalVersion: skills.basedOnGlobalVersion,
    })
    .from(skills)
    .where(
      and(
        eq(skills.scope, 'project'),
        eq(skills.basedOnGlobalSkillId, bump.globalSkillId),
        or(isNull(skills.basedOnGlobalVersion), lt(skills.basedOnGlobalVersion, bump.newVersion)),
      ),
    );

  const result: TemplateDriftSweepResult = { behind: copies.length, drafted: 0, skipped: 0 };

  for (const copy of copies) {
    if (!copy.projectId) continue;
    try {
      const [existing] = await db
        .select({ id: issues.id })
        .from(issues)
        .where(
          and(
            eq(issues.projectId, copy.projectId),
            ne(issues.status, 'closed'),
            sql`${issues.title} LIKE ${`${REBASE_TITLE_PREFIX(bump.name)}%`}`,
          ),
        )
        .limit(1);
      if (existing) {
        result.skipped += 1;
        continue;
      }

      const [project] = await db
        .select({ createdBy: projects.createdBy })
        .from(projects)
        .where(eq(projects.id, copy.projectId))
        .limit(1);
      if (!project) continue;

      await db.insert(issues).values({
        projectId: copy.projectId,
        title: `${REBASE_TITLE_PREFIX(bump.name)}v${copy.basedOnGlobalVersion ?? '?'}→v${bump.newVersion}`,
        description: rebaseIssueDescription(bump),
        // draft = the human gate — NEVER 'open' (open auto-triages a run).
        status: 'draft',
        priority: 'medium',
        category: 'skills',
        createdById: project.createdBy,
      });
      result.drafted += 1;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, projectId: copy.projectId, skill: bump.name },
        'template-propagation: draft rebase issue failed',
      );
    }
  }

  logger.info({ ...bump, ...result }, 'template-propagation: drift sweep complete');
  return result;
}

/**
 * Sweep a batch of bumps (the seed's change list). Never throws — the boot
 * path must not fail because a rebase draft could not be created.
 */
export async function sweepTemplateBumps(
  bumps: TemplateBump[],
): Promise<TemplateDriftSweepResult[]> {
  const results: TemplateDriftSweepResult[] = [];
  for (const bump of bumps) {
    try {
      results.push(await sweepTemplateDrift(bump));
    } catch (err) {
      logger.error(
        { err: (err as Error).message, skill: bump.name },
        'template-propagation: sweep failed for bump',
      );
    }
  }
  return results;
}
