/**
 * Which issues a master may open a run session over (ISS-917, ISS-933).
 *
 * A second surface beside `readPool`, answering a different question. The pool
 * says "what job may I claim"; this says "what is sitting here that no run and
 * no job has been opened for". A master reads both and decides.
 *
 * It was called the *backlog* while a row here became work only by being
 * promoted into a `drive` job. ISS-933 deleted that act — a master opens the
 * run session itself — so the name is the fact now rather than the pool key.
 *
 * Opt-in per project via `pipelineConfig.poolBacklog`. A project that has not
 * declared one contributes nothing.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import {
  AUTONOMOUS_ENTRY_STATUS,
  isAutonomous,
  isEntryGateClosed,
} from '../pipeline/autonomous-mode.js';
import { pipelineConfigSchema } from '../pipeline/pipeline-config-schema.js';
import type { PoolRelation } from './pool.js';

const DEFAULT_ADMISSIBLE_LIMIT = 20;

export type AdmissibleIssue = {
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
  /** Raw evidence fields (`pipeline/status-assertions.ts`). Facts, not a verdict. */
  mergedAt: string | null;
  branch: string | null;
};

/** Statuses this project admits, and how many rows it lets a master read. */
export type Admission = {
  projectId: string;
  statuses: string[];
  limit: number;
  entryOnRelease: boolean;
};

function admissionOf(projectId: string, agentConfig: unknown): Admission | null {
  const ac = (agentConfig as { pipelineConfig?: unknown } | null) ?? {};
  const parsed = pipelineConfigSchema.safeParse(ac.pipelineConfig ?? {});
  if (!parsed.success) return null;
  const cfg = parsed.data;
  const statuses = new Set<string>(cfg.poolBacklog?.statuses ?? []);
  const entryOpen = isAutonomous(cfg) && !isEntryGateClosed(cfg);
  if (entryOpen) statuses.add(AUTONOMOUS_ENTRY_STATUS);
  if (statuses.size === 0) return null;
  return {
    projectId,
    statuses: [...statuses],
    limit: cfg.poolBacklog?.limit ?? DEFAULT_ADMISSIBLE_LIMIT,
    entryOnRelease: isAutonomous(cfg) && !entryOpen,
  };
}

/**
 * Every project this device is bound to that has declared an admissible set.
 *
 * Scoped through `runners` exactly as `readPool` is: the device principal sees
 * its own bindings and nothing its owner's account could otherwise reach.
 */
export async function readAdmissions(args: {
  deviceId: string;
  projectId?: string | undefined;
}): Promise<Admission[]> {
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
    .filter((a): a is Admission => a !== null);
}

const RELATIONS = sql`
  COALESCE((
    SELECT json_agg(json_build_object(
      'kind', d.kind,
      'dependsOnKey', coalesce(bp.issue_prefix, 'ISS') || '-' || b.iss_seq,
      'blockerStatus', b.status,
      'blockerMergedAt', b.merged_at,
      'edgeValidUntil', d.valid_until
    ))
    FROM issue_dependencies d
    JOIN issues b ON b.id = d.from_issue_id
    JOIN projects bp ON bp.id = b.project_id
    WHERE d.to_issue_id = i.id
  ), '[]'::json) AS relations
`;

/**
 * The admissible issues for one device, across every project it serves.
 *
 * `limit` is per project (each declares its own), so this is one query per
 * admitting project rather than one windowed query — a device serves a handful
 * of projects, and a per-project cap expressed in SQL windows is unreadable for
 * no gain.
 */
export async function readAdmissibleIssues(args: {
  deviceId: string;
  projectId?: string | undefined;
}): Promise<AdmissibleIssue[]> {
  const admissions = await readAdmissions(args);
  if (admissions.length === 0) return [];

  const out: AdmissibleIssue[] = [];
  for (const a of admissions) {
    const statusList = sql.join(
      a.statuses.map((s) => sql`${s}`),
      sql`, `,
    );
    const rows = (await db.execute(sql`
      SELECT i.id, i.iss_seq, i.project_id, i.title, i.description, i.priority,
             i.category, i.status, i.merged_at,
             i.session_context->>'branch' AS branch,
             EXTRACT(EPOCH FROM (now() - i.created_at)) / 60 AS age_minutes,
             ip.issue_prefix,
             ${RELATIONS}
      FROM issues i
      JOIN projects ip ON ip.id = i.project_id
      WHERE i.project_id = ${a.projectId}
        AND (
          i.status IN (${statusList})
          ${a.entryOnRelease ? sql`OR (i.status = ${AUTONOMOUS_ENTRY_STATUS} AND i.session_context ? 'runRelease')` : sql``}
        )
        -- cm:guard asks whether a job is LIVE, never whether one ever existed: a terminal row is history, and held is a job a session still owns so it stays excluding. Unfiltered, this hid every issue a pre-ISS-933 dispatcher had ever minted for — zero admissible rows on all 25 projects forge-vm serves, measured 2026-09-08.
        AND NOT EXISTS (
          SELECT 1 FROM jobs j
          WHERE j.issue_id = i.id AND j.status NOT IN ('done', 'failed', 'cancelled')
        )
        AND NOT EXISTS (
          SELECT 1 FROM pipeline_runs pr
          WHERE pr.issue_id = i.id AND pr.status IN ('running', 'paused')
        )
        -- cm:guard a run session is CROSS-BOX state and the per-box ledger cannot see it. Without this, two boxes serving one project each open a run over the same issue, and each ledger correctly reports no conflict (ISS-933 criterion 7).
        AND NOT EXISTS (
          SELECT 1 FROM pipeline_runs rs
          WHERE rs.project_id = i.project_id
            AND rs.kind = 'system'
            AND rs.status IN ('running', 'paused')
            -- cm:guard CANONICAL on purpose: runIssues holds the form openRunSession
            -- canonicalised, never the project's own prefix, so this containment must not take
            -- issue_prefix into account or a run's issues silently stop being seen (ISS-992)
            AND rs.metadata -> 'runIssues' @> to_jsonb('ISS-' || i.iss_seq) -- ISS-992:canonical
        )
      ORDER BY i.created_at ASC
      LIMIT ${a.limit}
    `)) as unknown as Array<Record<string, unknown>>;

    for (const row of rows) {
      out.push({
        issueId: String(row.id),
        issueKey:
          row.iss_seq == null
            ? null
            : formatIssueRef(row.issue_prefix as string | null, Number(row.iss_seq)),
        projectId: String(row.project_id),
        title: (row.title as string | null) ?? null,
        description: (row.description as string | null) ?? null,
        priority: (row.priority as string | null) ?? null,
        category: (row.category as string | null) ?? null,
        status: String(row.status),
        ageMinutes: Number(row.age_minutes ?? 0),
        relations: (row.relations as PoolRelation[] | null) ?? [],
        mergedAt: row.merged_at == null ? null : new Date(row.merged_at as string).toISOString(),
        branch: (row.branch as string | null) || null,
      });
    }
  }
  return out;
}
