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
  type IssuePullRequest,
  readPullRequestsForIssues,
} from '../integrations/repo-projection.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import {
  BLOCKER_SETTLED_STATUSES,
  DISPATCH_GATING_KIND,
} from '../issues/dependency-effects.js';
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
  /**
   * What the repository says about this issue, as events reported it: every pull request linked to
   * it, open first. Empty where none is held, and empty on a project whose repository Forge is not
   * bound to — the same shape, because a master that has to tell those two apart reads the project's
   * integrations rather than guessing from a null here.
   */
  pullRequests: IssuePullRequest[];
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

// cm:guard the same blocker facts `readPool` returns, keyed off the issue rather than a job — raw status and merge stamp, NEVER a computed `satisfied`. Since ISS-1100 the WHERE clause below does gate on a blocks edge, and the two are not in tension: the query decides whether a row is offered at all, and the payload still hands over what the master needs to decide what to DO about the blockers on a row it was offered. Folding these three into a boolean would destroy that — `merged_at` set with status `reopen` means landed-then-bounced, `dropped` means abandoned, and both collapse to the same `false`.
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
// cm:guard the exclusions are "work is OPEN on this issue right now" PLUS the one dependency filter below, and NOTHING else — no priority ordering, no merge state, no pull-request state, no cap beyond the project's own declared `limit`. Those remain the master's judgements. Read as "has ever been opened" the liveness clauses would exclude on history, which is the ISS-933 measurement below.
// cm:guard the dependency filter was forbidden here until ISS-1100, by this guard, on the ground that blocked-or-not is "the master's judgement". What that reasoning left out is the price: every row offered here that the master then refuses costs a full agent pass. Measured over the 24h to 2026-09-19 on forge-vm — 1,630 nudges, 258 of them to codemap, whose entire candidate set of five sat behind unanswered blockers and produced not one run. The judgement was never in doubt, only re-derived 258 times at ~$0.18 each.
// cm:guard the filter is a MIRROR of `holdsBack` in forge-plugin's `src/flow/earned.mjs`, and core's hidden set must stay a STRICT SUBSET of what the master refuses. Core may be more permissive and pay a nudge; it may never be less, because a row core hides is work nobody ever sees. That is why `valid_until` is honoured here although `holdsBack` does not consult it: a retracted edge, and the expired edges `drop-cascade.ts` writes when a blocker is dropped, are offered by core and refused by the master. The disagreement is deliberate, is in the safe direction, and its other half is a defect reported on the `forge-plugin` project.
// cm:guard the filter reads the blocker's STATUS and never `merged_at`, because the master's does. `dependency-effects.ts:GATES_DISPATCH_NOTE` used to publish the merge rule while nothing enforced it; both now say this.
// cm:guard `pullRequests` is subject to this same rule and to the one above it: a row whose pull request conflicts, is red or is behind is STILL OFFERED. What the projection buys the master is the ability to tell "green and waiting" from "conflicts" before it spends a session; what it must never buy the kernel is a second place to decide. No WHERE clause here reads `repo_pull_requests` (ISS-1062).
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
    const settledList = sql.join(
      BLOCKER_SETTLED_STATUSES.map((s) => sql`${s}`),
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
        -- cm:guard ISS-1100 — the ONE dependency clause, mirroring holdsBack in forge-plugin:
        -- a live blocks edge whose blocker has not reached one of BLOCKER_SETTLED_STATUSES holds
        -- this row out of the set. It is correlated on the ADMITTING project and not on
        -- d.to_issue_id alone, because issue_dependencies carries only the composite indexes
        -- (project_id, from_issue_id) and (project_id, to_issue_id): an endpoint-only filter
        -- constrains the non-leading column of both and Postgres degrades to a sequential scan of
        -- every edge in the table. setIssueDependency refuses an edge whose endpoints are not both
        -- in that project, so the correlation narrows nothing a master could take.
        AND NOT EXISTS (
          SELECT 1 FROM issue_dependencies d
          JOIN issues b ON b.id = d.from_issue_id
          WHERE d.project_id = ${a.projectId}
            AND d.to_issue_id = i.id
            AND d.kind = ${DISPATCH_GATING_KIND}
            AND (d.valid_until IS NULL OR d.valid_until > now())
            AND b.status NOT IN (${settledList})
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

    // cm:why one read for the page rather than one per row: the projection is keyed on the issue and a master reads twenty at a time, so a per-row lookup would turn one admissible call into twenty-one queries.
    const byIssue = await readPullRequestsForIssues(rows.map((r) => String(r.id)));

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
        pullRequests: byIssue.get(String(row.id)) ?? [],
      });
    }
  }
  return out;
}
