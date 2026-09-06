/**
 * What EXISTS that nobody has decided about yet (ISS-917).
 *
 * A second surface beside `readPool`, answering a different question. The pool
 * says "what may I claim"; the backlog says "what is sitting here that no run
 * and no job has been opened for". A master reads both and decides, per issue,
 * whether to pull one up now — `promoteFromBacklog` is that act, and it is the
 * only way a row here becomes work.
 *
 * Opt-in per project via `pipelineConfig.poolBacklog`. A project that has not
 * declared one contributes nothing, which is every project's behaviour before
 * this file existed.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineConfigSchema } from '../pipeline/pipeline-config-schema.js';
import type { PoolRelation } from './pool.js';

const DEFAULT_BACKLOG_LIMIT = 20;

// cm:guard NO `jobId` on this type, and never add one. A row a master could pass to `pool claim` is a malformed claim waiting to happen, and keeping one off it is the whole reason (ISS-917 B6) the backlog is a sibling key of the pool response rather than more `items`.
export type BacklogEntry = {
  issueId: string;
  issueKey: string | null;
  projectId: string;
  title: string | null;
  description: string | null;
  priority: string | null;
  category: string | null;
  status: string;
  ageMinutes: number;
  relations: PoolRelation[];
};

/** Statuses this project admits, and how many rows it lets a master read. */
export type BacklogAdmission = { projectId: string; statuses: string[]; limit: number };

// cm:guard parse through the CANONICAL schema, never read the jsonb by hand: a config this build can no longer parse (a status dropped from `BACKLOG_ADMISSIBLE_STATUSES`, a key removed) must read as NO BACKLOG, because a hand-read keeps offering rows `promoteFromBacklog` then refuses and the master cannot tell which of the two is wrong.
function admissionOf(projectId: string, agentConfig: unknown): BacklogAdmission | null {
  const ac = (agentConfig as { pipelineConfig?: unknown } | null) ?? {};
  const parsed = pipelineConfigSchema.safeParse(ac.pipelineConfig ?? {});
  if (!parsed.success) return null;
  const cfg = parsed.data.poolBacklog;
  if (!cfg || cfg.statuses.length === 0) return null;
  return {
    projectId,
    statuses: [...new Set(cfg.statuses)],
    limit: cfg.limit ?? DEFAULT_BACKLOG_LIMIT,
  };
}

/**
 * Every project this device is bound to that has declared a backlog.
 *
 * Scoped through `runners` exactly as `readPool` is: the device principal sees
 * its own bindings and nothing its owner's account could otherwise reach.
 */
export async function readBacklogAdmissions(args: {
  deviceId: string;
  projectId?: string | undefined;
}): Promise<BacklogAdmission[]> {
  const projectFilter = args.projectId ? sql`AND p.id = ${args.projectId}` : sql``;
  const rows = (await db.execute(sql`
    SELECT DISTINCT p.id, p.agent_config
    FROM runners r
    JOIN projects p ON p.id = r.project_id
    WHERE r.device_id = ${args.deviceId}
      AND p.archived_at IS NULL
      ${projectFilter}
  `)) as unknown as Array<Record<string, unknown>>;

  return rows
    .map((row) => admissionOf(String(row.id), row.agent_config))
    .filter((a): a is BacklogAdmission => a !== null);
}

// cm:guard the same blocker facts `readPool` returns, keyed off the issue rather than a job — raw status and merge stamp, NEVER a computed `satisfied`: deciding whether a blocker is settled is the master's judgement, and a backlog that pre-answers it is the kernel routing again through a second door.
const RELATIONS = sql`
  COALESCE((
    SELECT json_agg(json_build_object(
      'kind', d.kind,
      'dependsOnKey', 'ISS-' || b.iss_seq,
      'blockerStatus', b.status,
      'blockerMergedAt', b.merged_at,
      'edgeValidUntil', d.valid_until
    ))
    FROM issue_dependencies d
    JOIN issues b ON b.id = d.from_issue_id
    WHERE d.to_issue_id = i.id
  ), '[]'::json) AS relations
`;

/**
 * The declared backlog for one device, across every project it serves.
 *
 * `limit` is per project (each declares its own), so this is one query per
 * admitting project rather than one windowed query — a device serves a handful
 * of projects, and a per-project cap expressed in SQL windows is unreadable for
 * no gain.
 */
// cm:guard the exclusions are "no work has been opened for this issue" and NOTHING else — no dependency filter, no priority ordering, no cap beyond the project's own declared `limit`. Same rule `readPool` carries and for the same reason: those are the master's judgements, and a backlog that pre-decides them is the kernel routing again through a second door.
export async function readBacklog(args: {
  deviceId: string;
  projectId?: string | undefined;
}): Promise<BacklogEntry[]> {
  const admissions = await readBacklogAdmissions(args);
  if (admissions.length === 0) return [];

  const out: BacklogEntry[] = [];
  for (const a of admissions) {
    const statusList = sql.join(
      a.statuses.map((s) => sql`${s}`),
      sql`, `,
    );
    const rows = (await db.execute(sql`
      SELECT i.id, i.iss_seq, i.project_id, i.title, i.description, i.priority,
             i.category, i.status,
             EXTRACT(EPOCH FROM (now() - i.created_at)) / 60 AS age_minutes,
             ${RELATIONS}
      FROM issues i
      WHERE i.project_id = ${a.projectId}
        AND i.status IN (${statusList})
        AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.issue_id = i.id)
        AND NOT EXISTS (
          SELECT 1 FROM pipeline_runs pr
          WHERE pr.issue_id = i.id AND pr.status IN ('running', 'paused')
        )
      ORDER BY i.created_at ASC
      LIMIT ${a.limit}
    `)) as unknown as Array<Record<string, unknown>>;

    for (const row of rows) {
      out.push({
        issueId: String(row.id),
        issueKey: row.iss_seq == null ? null : `ISS-${row.iss_seq}`,
        projectId: String(row.project_id),
        title: (row.title as string | null) ?? null,
        description: (row.description as string | null) ?? null,
        priority: (row.priority as string | null) ?? null,
        category: (row.category as string | null) ?? null,
        status: String(row.status),
        ageMinutes: Number(row.age_minutes ?? 0),
        relations: (row.relations as PoolRelation[] | null) ?? [],
      });
    }
  }
  return out;
}
