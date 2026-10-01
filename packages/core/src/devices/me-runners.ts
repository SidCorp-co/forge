import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { knowledgeEntries, projects, runners } from '../db/schema.js';
import { readDeclaredSource } from '../project-config/source.js';

/** Seconds left on this runner's rate limit: `null` unlimited, `0` expired. */
function rateLimitedForSecondsSql() {
  return sql<number | null>`CASE
    WHEN ${runners.rateLimitedUntil} IS NULL THEN NULL
    ELSE GREATEST(0, EXTRACT(EPOCH FROM (${runners.rateLimitedUntil} - now()))::int)
  END`;
}

/** The owner's standing instruction for this project's master, or `null`. */
function masterPolicySql() {
  return sql<string | null>`(
    SELECT ke.body FROM ${knowledgeEntries} ke
     WHERE ke.project_id = ${projects.id}
       AND ke.slug = 'master-policy'
       AND ke.archived_at IS NULL
     LIMIT 1
  )`;
}

/** Every `claude-code` runner row this device owns, joined to its project. */
export async function listDeviceAssignments(deviceId: string) {
  const rows = await db
    .select({
      projectId: runners.projectId,
      runnerId: runners.id,
      slug: projects.slug,
      baseBranch: projects.baseBranch,
      repoPath: runners.repoPath,
      branch: runners.branch,
      status: runners.status,
      masterPolicy: masterPolicySql(),
      rateLimitedForSeconds: rateLimitedForSecondsSql(),
      limitReason: runners.limitReason,
    })
    .from(runners)
    .innerJoin(projects, eq(projects.id, runners.projectId))
    .where(and(eq(runners.deviceId, deviceId), eq(runners.type, 'claude-code')));
  const setups = new Map<string, string | null>();
  for (const projectId of new Set(rows.map((r) => r.projectId))) {
    setups.set(projectId, (await readDeclaredSource(projectId)).setup);
  }
  return rows.map((r) => ({ ...r, workspaceSetup: setups.get(r.projectId) ?? null }));
}
