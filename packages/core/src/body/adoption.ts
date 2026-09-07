/**
 * How much of what agents actually write is a typed component, per stage.
 *
 * The mandate ladder in `docs/proposals/body-templates.md` says a stage goes to
 * required only after two weeks of adoption data. Before this module there was
 * nothing to measure with: "what fraction of review comments carry
 * `forge-review` this week" needed SQL against production by hand, which is the
 * shape of question that goes unasked and then gets a mandate argued from
 * impressions.
 *
 * It counts what is STORED — `format='html'` plus the `template` column the
 * kernel normalized on the way in — never a regex over body text, which would
 * count a body that merely mentions `forge-outcome` in a sentence. A number
 * that counts intentions reads exactly like a real one.
 */
// cm:guard the POPULATION is `author_agency = 'agent'`, the same column `refuseMissingComponent` reads, so the fraction always describes the rule that exists. An earlier draft used `author_device_id IS NOT NULL`; ISS-932 wave 4 made that the box a credential was issued to and a driver's `job:` token carries none, so it would have counted almost nothing while reading like a real zero.

import { and, eq, gte, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments, issues, projects } from '../db/schema.js';
import { STAGE_NAMES, type StageName } from '../pipeline/pipeline-config-schema.js';
import { type BodyPolicyConfigSource, resolveStageBodyPolicy } from './stage-policy.js';

export interface StageAdoption {
  stage: StageName;
  /** Comment bodies the POLICY applies to — `author_agency = 'agent'` — in the window. */
  total: number;
  /** Count per stored root component, over `total`. Absent keys are zero, not unknown. */
  byComponent: Record<string, number>;
  /** What this stage requires today, or `null` — which is where every stage starts. */
  requireComponent: string | null;
  /** Of `total`, how many carry `requireComponent`. `null` when nothing is required. */
  carryingRequired: number | null;
  /** `carryingRequired / total`, or `null` when nothing is required or nothing was written. */
  fractionRequired: number | null;
}

export interface BodyAdoptionReport {
  windowDays: number;
  since: string;
  stages: StageAdoption[];
}

export const ADOPTION_DEFAULT_WINDOW_DAYS = 14;

/**
 * Why the denominator is agent-authored comments and not all of them: the
 * policy this number exists to inform never applies to a person, so counting
 * people's prose would depress the very figure the decision reads and make a
 * stage look unready forever.
 */
// cm:edge contract -> packages/core/src/comments/service.ts — `insertComment` writes all three columns this reads (`stage` from the issue's status, `template` from `prepareBody`, `author_agency` from the door's principal), and `author_agency = 'agent'` is the SAME test `refuseMissingComponent` applies. Change the test there and this number silently starts measuring a different population than the rule does, which is the one way a mandate gets raised against a figure that was never about it.
export async function readBodyAdoption(
  projectId: string,
  windowDays: number = ADOPTION_DEFAULT_WINDOW_DAYS,
): Promise<BodyAdoptionReport> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      stage: comments.stage,
      format: comments.format,
      template: comments.template,
      n: sql<number>`count(*)::int`,
    })
    .from(comments)
    .innerJoin(issues, eq(comments.issueId, issues.id))
    .where(
      and(
        eq(issues.projectId, projectId),
        gte(comments.createdAt, since),
        isNotNull(comments.stage),
        eq(comments.authorAgency, 'agent'),
      ),
    )
    .groupBy(comments.stage, comments.format, comments.template);

  const [project] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const policySource = (project?.agentConfig ?? null) as BodyPolicyConfigSource | null;

  // cm:guard both columns, not `template` alone. A markdown row cannot hold a template today, so the format test looks redundant — it is the assertion that keeps it that way, and it is the one line standing between this number and a future writer that stores a guess.
  const tally = (mine: typeof rows) => {
    const byComponent: Record<string, number> = {};
    for (const r of mine) {
      if (r.format !== 'html' || !r.template) continue;
      byComponent[r.template] = (byComponent[r.template] ?? 0) + r.n;
    }
    return { total: mine.reduce((sum, r) => sum + r.n, 0), byComponent };
  };

  const stages = STAGE_NAMES.map((stage) => {
    const { total, byComponent } = tally(rows.filter((r) => r.stage === stage));
    const requireComponent = resolveStageBodyPolicy(policySource, stage)?.requireComponent ?? null;
    const carryingRequired = requireComponent ? (byComponent[requireComponent] ?? 0) : null;
    return {
      stage,
      total,
      byComponent,
      requireComponent,
      carryingRequired,
      fractionRequired: carryingRequired !== null && total > 0 ? carryingRequired / total : null,
    };
  });

  return { windowDays, since: since.toISOString(), stages };
}
