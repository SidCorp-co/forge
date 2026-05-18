import { and, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import pkg from '../../../package.json' with { type: 'json' };
import { db } from '../../db/client.js';
import { agentSessions, jobs, projects, runners } from '../../db/schema.js';
import { isBossStarted } from '../../queue/boss.js';
import { isWsListening } from '../../ws/server.js';
import {
  type ContextScopedMcpToolFactory,
  assertPrincipalIsSystemAdmin,
  zodToMcpSchema,
} from './lib.js';

const inputSchema = z
  .object({
    action: z.enum(['get']).optional(),
    staleJobThresholdSeconds: z.number().int().min(60).max(86_400).optional(),
  })
  .strict();

type RunnerRow = typeof runners.$inferSelect;

export const forgeAdminHealthTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_admin_health',
  description:
    "Extended health snapshot for system admin (`users.isCeo=true`). Returns `{ version, uptimeSeconds, db, queue, ws, runners: [{ id, name, projectId, status, lastSeenAt, inFlightCount }], projects: [{ id, slug, activeJobCount }], stuckJobs: [{ jobId, type, runnerId, dispatchedAt, ageSeconds }] }`. `staleJobThresholdSeconds` (60..86400, default 600) controls the stuckJobs cutoff.",
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const staleJobThresholdSeconds = input.staleJobThresholdSeconds ?? 600;
    await assertPrincipalIsSystemAdmin(ctx.principal);

    let dbOk = false;
    try {
      await db.execute(sql`select 1`);
      dbOk = true;
    } catch {
      dbOk = false;
    }

    const runnerRows: RunnerRow[] = dbOk ? await db.select().from(runners) : [];
    let inFlightByRunner = new Map<string, number>();
    if (dbOk && runnerRows.length > 0) {
      const aggregated = await db
        .select({ runnerId: jobs.runnerId, n: sql<number>`count(*)::int` })
        .from(jobs)
        .where(
          and(
            inArray(
              jobs.runnerId,
              runnerRows.map((r) => r.id),
            ),
            inArray(jobs.status, ['dispatched', 'running']),
          ),
        )
        .groupBy(jobs.runnerId);
      inFlightByRunner = new Map(
        aggregated
          .filter((r): r is { runnerId: string; n: number } => r.runnerId !== null)
          .map((r) => [r.runnerId, Number(r.n ?? 0)]),
      );
    }

    const runnersOut = runnerRows.map((r) => ({
      id: r.id,
      name: r.name,
      projectId: r.projectId,
      status: r.status,
      lastSeenAt: r.lastSeenAt,
      inFlightCount: inFlightByRunner.get(r.id) ?? 0,
    }));

    // Per-project active session count. Cap at top-50 projects by active count
    // to keep the payload bounded.
    let projectsOut: Array<{ id: string; slug: string; activeJobCount: number }> = [];
    if (dbOk) {
      const projectRows = await db
        .select({
          id: projects.id,
          slug: projects.slug,
          n: sql<number>`count(${agentSessions.id})::int`,
        })
        .from(projects)
        .leftJoin(
          agentSessions,
          sql`${agentSessions.projectId} = ${projects.id} AND ${agentSessions.status} IN ('queued','running')`,
        )
        .groupBy(projects.id, projects.slug)
        .orderBy(sql`count(${agentSessions.id}) DESC`)
        .limit(50);
      projectsOut = projectRows.map((r) => ({
        id: r.id,
        slug: r.slug,
        activeJobCount: Number(r.n ?? 0),
      }));
    }

    let stuckJobs: Array<{
      jobId: string;
      type: string;
      runnerId: string | null;
      dispatchedAt: string | null;
      ageSeconds: number;
    }> = [];
    if (dbOk) {
      const rows = await db.execute<{
        id: string;
        type: string;
        runner_id: string | null;
        dispatched_at: string | null;
        age_seconds: string | number | null;
      }>(sql`
        SELECT id, type, runner_id, dispatched_at,
               EXTRACT(EPOCH FROM (now() - dispatched_at))::int AS age_seconds
        FROM jobs
        WHERE status = 'dispatched'
          AND dispatched_at IS NOT NULL
          AND dispatched_at < now() - (${staleJobThresholdSeconds}::int * interval '1 second')
        ORDER BY dispatched_at ASC
        LIMIT 50
      `);
      stuckJobs = rows.map((r) => ({
        jobId: r.id,
        type: r.type,
        runnerId: r.runner_id,
        dispatchedAt: r.dispatched_at,
        ageSeconds: Number(r.age_seconds ?? 0),
      }));
    }

    return {
      version: pkg.version,
      uptimeSeconds: Math.floor(process.uptime()),
      db: dbOk ? 'ok' : 'down',
      queue: isBossStarted() ? 'ok' : 'down',
      ws: isWsListening() ? 'ok' : 'down',
      runners: runnersOut,
      projects: projectsOut,
      stuckJobs,
      staleJobThresholdSeconds: staleJobThresholdSeconds,
    };
  },
});
