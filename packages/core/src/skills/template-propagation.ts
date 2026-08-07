import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { skills } from '../db/schema.js';
import { logger } from '../logger.js';

/**
 * ISS-605 — template-propagation, the rebase lane.
 *
 * Global skills are catalog TEMPLATES; every usable skill is a project COPY
 * frozen at adoption time (see effective.ts). When a template bumps, this
 * sweep reports how many project copies fell behind. It does NOT write
 * anything — `behindTemplate` is already derivable from
 * `basedOnGlobalVersion` vs the template's `version`, and `forge_skills.list`
 * computes it per row on demand.
 *
 * It used to draft one `skill-rebase` issue per (project, skill). That was
 * removed: the issue carried no information the skill row did not already
 * hold, and its idempotency guard — "skip a project that has ANY non-closed
 * `skill-rebase: <name> …` issue" — meant an un-consumed draft permanently
 * suppressed every LATER bump for that skill. Measured 2026-08-06: 75 such
 * drafts across 15 projects, and 10 of 15 projects were silently invisible to
 * the `forge-test` v15 bump because they still held a v14 draft nobody closed.
 * A notice that rots into a mute switch is worse than no notice.
 *
 * Called from `seedBuiltinSkills` (the only path that bumps a global's
 * version). Failures are logged and swallowed: a sweep problem must never
 * fail the seed/boot path.
 */

export interface TemplateBump {
  globalSkillId: string;
  name: string;
  oldVersion: number;
  newVersion: number;
}

export interface TemplateDriftSweepResult {
  /** Project copies now behind this template. Surfaced in Skill Studio. */
  behind: number;
}

/** Count project copies left behind by one template bump. Read-only. */
export async function sweepTemplateDrift(bump: TemplateBump): Promise<TemplateDriftSweepResult> {
  const copies = await db
    .select({ skillId: skills.id, projectId: skills.projectId })
    .from(skills)
    .where(
      and(
        eq(skills.scope, 'project'),
        eq(skills.basedOnGlobalSkillId, bump.globalSkillId),
        or(isNull(skills.basedOnGlobalVersion), lt(skills.basedOnGlobalVersion, bump.newVersion)),
      ),
    );

  const result: TemplateDriftSweepResult = { behind: copies.length };
  logger.info({ ...bump, ...result }, 'template-propagation: drift sweep complete');
  return result;
}

/** Sweep a batch of bumps (the seed's change list). Never throws. */
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
