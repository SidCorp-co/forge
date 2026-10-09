/**
 * Which issues a master may open a run session over (ISS-917, ISS-933).
 *
 * A second surface beside `readPool`, answering a different question. The pool
 * says "what job may I claim"; this says "what is sitting here that no run and
 * no job has been opened for". A master reads both and decides.
 *
 * A project admits every takeable status (`@forge/contracts/issue-machine:TAKEABLE_STATUSES`, the set
 * `forge next` ranks), so a reopened issue is admissible exactly where `forge next` lists it. Its
 * entry status is admitted when the policy's intake is `auto`, and only the issues a human released
 * there when it is `manual`; a `reopen` is already a person's word and waits on no release. A project
 * with no policy admits nothing and is named in `refused`, never left out in silence.
 */

import { TAKEABLE_STATUSES } from '@forge/contracts/issue-machine';
import type { PolicyRefusalCode } from '@forge/contracts/project-config';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  blockedByUnsettledSql,
  contractWaitUnsettledSql,
  designUnapprovedSql,
  dispatchOrderSql,
  issueWorkInFlightSql,
  patternReviewPendingSql,
} from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { AUTONOMOUS_ENTRY_STATUS, isEntryGateClosed } from '../pipeline/index.js';
import { type PoolRelation, relationsFor } from './pool.js';
import { devicesPorts } from './ports.js';

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
  /**
   * What the repository says about this issue, as events reported it: every pull request linked to
   * it, open first. Empty where none is held, and empty on a project whose repository Forge is not
   * bound to — the same shape, because a master that has to tell those two apart reads the project's
   * integrations rather than guessing from a null here.
   */
  pullRequests: unknown[];
};

export type Admission = {
  projectId: string;
  limit: number;
  entryOnRelease: boolean;
  /** The takeable statuses the policy declares a state for; a row at any other is withheld. */
  statuses: readonly string[];
};

/** A project this device serves that admits nothing, and the refusal that says why. */
type AdmissionRefusal = { projectId: string; code: PolicyRefusalCode; message: string };

/**
 * A project's admission under its policy, and a refusal for each takeable status the policy declares
 * no state for: a row there would be refused POLICY_STATE_UNDECLARED at the claim, so it is withheld
 * here and named, never handed out to fail.
 */
export function admissionOf(
  projectId: string,
  held: { document: unknown },
): { admission: Admission; refused: AdmissionRefusal[] } {
  const refused: AdmissionRefusal[] = [];
  const statuses = TAKEABLE_STATUSES.filter((status) => {
    const gap = devicesPorts().policyGapOf(projectId, held, status);
    if (gap) refused.push({ projectId, code: gap.code, message: gap.detail });
    return gap === null;
  });
  return {
    admission: {
      projectId,
      limit: DEFAULT_ADMISSIBLE_LIMIT,
      entryOnRelease: isEntryGateClosed(held.document as Parameters<typeof isEntryGateClosed>[0]),
      statuses,
    },
    refused,
  };
}

/**
 * Every project this device is bound to, scoped through `runners` exactly as `readPool` is: the
 * device principal sees
 * its own bindings and nothing its owner's account could otherwise reach.
 */
async function readAdmissions(args: {
  deviceId: string;
  projectId?: string | undefined;
}): Promise<{ admissions: Admission[]; refused: AdmissionRefusal[] }> {
  const projectFilter = args.projectId ? sql`AND p.id = ${args.projectId}` : sql``;
  const rows = (await db.execute(sql`
    SELECT DISTINCT p.id
    FROM runners r
    JOIN projects p ON p.id = r.project_id
    WHERE r.device_id = ${args.deviceId}
      AND p.archived_at IS NULL
      ${projectFilter}
  `)) as unknown as Array<Record<string, unknown>>;

  const admissions: Admission[] = [];
  const refused: AdmissionRefusal[] = [];
  for (const row of rows) {
    const projectId = String(row.id);
    const held = await devicesPorts().readEffectivePolicy(projectId);
    if (held) {
      const { admission, refused: undeclared } = admissionOf(projectId, held);
      if (admission.statuses.length > 0) admissions.push(admission);
      refused.push(...undeclared);
      continue;
    }
    const [refusal] = devicesPorts().policyRefusal('POLICY_UNDECLARED', projectId, null).refusals;
    refused.push({ projectId, code: 'POLICY_UNDECLARED', message: refusal?.detail ?? '' });
  }
  return { admissions, refused };
}

/**
 * The admissible issues for one device, across every project it serves.
 *
 * `limit` is per project, so this is one query per admitting project rather than one windowed
 * query: a device serves a handful of projects, and a per-project SQL window buys nothing.
 */
export async function readAdmissibleIssues(args: {
  deviceId: string;
  projectId?: string | undefined;
}): Promise<{ items: AdmissibleIssue[]; refused: AdmissionRefusal[] }> {
  const { admissions, refused } = await readAdmissions(args);
  const out: AdmissibleIssue[] = [];
  for (const a of admissions) {
    const takeableList = sql.join(
      a.statuses.map((s) => sql`${s}`),
      sql`, `,
    );
    const rows = (await db.execute(sql`
      SELECT i.id, i.iss_seq, i.project_id, i.title, i.description, i.priority,
             i.category, i.status, i.merged_at,
             (SELECT w.branch FROM issue_work_state w WHERE w.issue_id = i.id) AS branch,
             EXTRACT(EPOCH FROM (now() - i.created_at)) / 60 AS age_minutes,
             ip.issue_prefix,
             ${relationsFor(sql.raw('i.id'))}
      FROM issues i
      JOIN projects ip ON ip.id = i.project_id
      WHERE i.project_id = ${a.projectId}
        AND i.status IN (${takeableList})
        ${a.entryOnRelease ? sql`AND (i.status <> ${AUTONOMOUS_ENTRY_STATUS} OR i.session_context ? 'runRelease')` : sql``}
        AND NOT ${blockedByUnsettledSql({ issueId: sql`i.id`, projectId: a.projectId })}
        -- an issue that builds a workflow whose design is not approved, waits on a contract
        -- version no approved version settles, or names a new pattern no reviewer has decided, is withheld; Issues > Stuck names the refusal
        -- (issues/standing.ts:withheldTurn).
        AND NOT ${designUnapprovedSql(sql`i.id`)}
        AND NOT ${contractWaitUnsettledSql(sql`i.id`)}
        AND NOT ${patternReviewPendingSql(sql`i.id`)}
        -- one predicate for "is this issue being worked", shared with the orphan sweep that
        -- used to carry a verbatim copy of it (ISS-1109). The key is canonicalised and never
        -- the project's own prefix, or a run's issues silently stop being seen (ISS-992).
        AND NOT ${issueWorkInFlightSql({
          issueId: sql`i.id`,
          projectId: sql`i.project_id`,
          issueKey: sql`'ISS-' || i.iss_seq`, // ISS-992:canonical
        })}
      -- priority first, then oldest (issues/dispatch-order.ts), the order a master takes it top-down
      ORDER BY ${dispatchOrderSql('i')}
      LIMIT ${a.limit}
    `)) as unknown as Array<Record<string, unknown>>;

    const byIssue = await devicesPorts().readPullRequestsForIssues(rows.map((r) => String(r.id)));

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
  return { items: out, refused };
}
