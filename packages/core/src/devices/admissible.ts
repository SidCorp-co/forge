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
import {
  AUTONOMOUS_ENTRY_STATUS,
  isAutonomous,
  isEntryGateClosed,
} from '../pipeline/autonomous-mode.js';
import { pipelineConfigSchema } from '../pipeline/pipeline-config-schema.js';
import type { PoolRelation } from './pool.js';

const DEFAULT_ADMISSIBLE_LIMIT = 20;

// cm:guard `mergedAt` and `branch` are RAW EVIDENCE and must stay raw — never a `shipped`, `done` or `ready` boolean derived from them. A status answers only WHERE the work is (`pipeline/status-assertions.ts`); these two answer what EXISTS, and a master reading a backlog needs both to tell finished work from unstarted work. Without them a `draft` built by hand and a `draft` nobody has touched are the same row, because a hand-worked issue mints no job and the exclusions below key on jobs (ISS-940).
// cm:guard NO `jobId` on this type, and never add one. A row a master could pass to `pool claim` is a malformed claim waiting to happen, and keeping one off it is the whole reason (ISS-917 B6) the backlog is a sibling key of the pool response rather than more `items`.
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

// cm:guard parse through the CANONICAL schema, never read the jsonb by hand: a config this build can no longer parse (a status dropped from `BACKLOG_ADMISSIBLE_STATUSES`, a key removed) must read as NO admissible set, because a hand-read keeps offering rows the box then refuses and the master cannot tell which of the two is wrong.
// cm:guard the entry status is admitted for an AUTONOMOUS project and cannot come from `poolBacklog.statuses`, which is `issueStatuses` minus the driver statuses by construction. Since ISS-933 core mints no `drive` job, so without this an autonomous project offers nothing at all and goes silent with no error anywhere saying why (criterion 23).
// cm:edge lockstep -> packages/core/src/pipeline/autonomous-dispatch.ts — `isEntryGateClosed` used to decide whether core MINTS and now decides whether the issue is OFFERED. It is the same gate and the same word to an operator; both halves must move together or the project either stalls or starts work a human meant to release.
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
    // cm:guard a GATED autonomous project still admits an entry-status issue a human released by hand. The gate is per project and a Run is per issue, so without this the only way to release one is to open the gate for all of them.
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

// cm:guard the same blocker facts `readPool` returns, keyed off the issue rather than a job — raw status and merge stamp, NEVER a computed `satisfied`: deciding whether a blocker is settled is the master's judgement, and a list that pre-answers it is the kernel routing again through a second door.
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
 * The admissible issues for one device, across every project it serves.
 *
 * `limit` is per project (each declares its own), so this is one query per
 * admitting project rather than one windowed query — a device serves a handful
 * of projects, and a per-project cap expressed in SQL windows is unreadable for
 * no gain.
 */
// cm:guard the exclusions are "no work has been opened for this issue" and NOTHING else — no dependency filter, no priority ordering, no cap beyond the project's own declared `limit`. Same rule `readPool` carries and for the same reason: those are the master's judgements, and a list that pre-decides them is the kernel routing again through a second door.
// cm:guard a row carrying `mergedAt` is NOT excluded here, and adding such a filter is the wrong repair. `merged_at` is caller-asserted — any hop out of the base merge state stamps it, merge or not — so it is a fact to show the master, never grounds for the kernel to hide the row. Measured 2026-09-06: ISS-931 sat at `open` with its code on `origin/main` and was still offered as work (ISS-940).
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
             ${RELATIONS}
      FROM issues i
      WHERE i.project_id = ${a.projectId}
        AND (
          i.status IN (${statusList})
          ${a.entryOnRelease ? sql`OR (i.status = ${AUTONOMOUS_ENTRY_STATUS} AND i.session_context ? 'runRelease')` : sql``}
        )
        AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.issue_id = i.id)
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
            AND rs.metadata -> 'runIssues' @> to_jsonb('ISS-' || i.iss_seq)
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
        mergedAt: row.merged_at == null ? null : new Date(row.merged_at as string).toISOString(),
        branch: (row.branch as string | null) || null,
      });
    }
  }
  return out;
}
