/**
 * What method a release run is actually working from, on the record.
 *
 * The job stamped `skillName: 'release-flow'` and nothing invoked it — the
 * runner reads no such column and the prompt never named it — so a release ran
 * on whatever the agent made of the task prompt, and `finish` had no way to ask
 * whether it had a method at all. The prompt now emits the invocation line, and
 * this is the other half: the run says which method it loaded, and `finish`
 * refuses a run that never said.
 *
 * Stored on `pipeline_runs.metadata`, where the batch already keeps `gateStatus`
 * and `commitBefore`, and merged rather than replaced: metadata is a map several
 * writers share, and a whole-object write would drop every sibling key the batch
 * needs to reconstruct itself.
 */

import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';

export interface ReleaseMethod {
  /** The skill the run says it loaded. */
  skill: string;
  /** False when the agent announced that it could NOT load its method. */
  loaded: boolean;
  /** The agent's own words about what it loaded, or why it could not. */
  detail: string | null;
  announcedAt: string;
}

export class MethodNotAnnouncedError extends Error {
  constructor(public readonly expected: string) {
    super('RELEASE_METHOD_NOT_ANNOUNCED');
    this.name = 'MethodNotAnnouncedError';
  }
}

export class MethodMismatchError extends Error {
  constructor(
    public readonly announced: string,
    public readonly expected: string,
  ) {
    super('RELEASE_METHOD_MISMATCH');
    this.name = 'MethodMismatchError';
  }
}

// cm:guard `metadata || jsonb` and never a whole-object `set`. `pipeline_runs.metadata` carries `gateStatus`, `issueIds`, `deployPlanned`, `productionMergePlanned` and `commitBefore`, all written at creation, and `loadReleaseBatchContext` reconstructs the batch from them. A replace here empties the batch of everything but its method.
export async function announceMethod(args: {
  runId: string;
  skill: string;
  loaded: boolean;
  detail?: string | null | undefined;
}): Promise<ReleaseMethod> {
  const method: ReleaseMethod = {
    skill: args.skill,
    loaded: args.loaded,
    detail: args.detail ?? null,
    announcedAt: new Date().toISOString(),
  };
  await db
    .update(pipelineRuns)
    .set({
      metadata: sql`coalesce(${pipelineRuns.metadata}, '{}'::jsonb) || ${JSON.stringify({ method })}::jsonb`,
    })
    .where(eq(pipelineRuns.id, args.runId));
  return method;
}

export function readMethod(metadata: unknown): ReleaseMethod | null {
  const raw = (metadata as { method?: unknown } | null)?.method;
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.skill !== 'string' || m.skill.length === 0) return null;
  return {
    skill: m.skill,
    loaded: m.loaded === true,
    detail: typeof m.detail === 'string' ? m.detail : null,
    announcedAt: typeof m.announcedAt === 'string' ? m.announcedAt : '',
  };
}

/**
 * Refuse a run that never announced a method, and one that announced another
 * skill than the job it is running names.
 */
// cm:guard an announcement whose `loaded` is FALSE passes here, deliberately and temporarily. `release-flow` does not exist until forge-plugin ISS-1521 ships it, so refusing an unloaded method today halts every release on the fleet. Such a run is RECORDED and readable as one that ran without a method (criterion 29), and the refusal is one predicate away. Priced amnesty: `cm:hack ISS-1042 until:forge-plugin ISS-1521 ships plugin/skills/release-flow` — the cost meanwhile is that a run with no method is visible rather than blocked.
// cm:guard the MISMATCH is refused now and not deferred with it. A run announcing some other skill is not a plugin that has not shipped, it is a run working from a method nobody chose for it, and that is the case where the announcement is worth anything at all.
export function assertMethodFor(method: ReleaseMethod | null, expected: string): void {
  if (method === null) throw new MethodNotAnnouncedError(expected);
  if (method.skill !== expected) throw new MethodMismatchError(method.skill, expected);
}
