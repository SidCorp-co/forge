import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';

/** What a release run says it is running under: a record nothing refuses on (ISS-1276). */
export interface ReleaseMethod {
  /** The skill the run says it loaded. */
  skill: string;
  /** False when the agent announced that it could NOT load its method. */
  loaded: boolean;
  /** The agent's own words about what it loaded, or why it could not. */
  detail: string | null;
  announcedAt: string;
}

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
 * The method a release run announced, read by run id alone.
 *
 * `null` for a run that announced none and for a run that does not exist; the
 * caller asking is one that has already established which run it holds.
 */
export async function readRunMethod(runId: string): Promise<ReleaseMethod | null> {
  const [run] = await db
    .select({ metadata: pipelineRuns.metadata })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  return readMethod(run?.metadata ?? null);
}
