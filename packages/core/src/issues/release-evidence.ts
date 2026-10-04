// ISS-55 — the evidence `awaiting_release` stands on, read from `criterion_verdicts`, never comments.

import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import { type CriterionWithVerdict, listCriteria } from './criteria/store.js';
import {
  type CurrentDrafts,
  draftWorkflowIds,
  NO_DRAFTS_READ,
  readCurrentDrafts,
  withDrafts,
} from './criteria/storefront-draft.js';

const PASSING: ReadonlySet<string> = new Set(['pass', 'short']);

export type CriteriaEvidence =
  | { kind: 'no-criteria' }
  | {
      kind: 'criteria';
      unpassed: Array<{ criterion: number; verdict: string | null }>;
      /** Passing, with no identity the gate accepts; a backfilled `commit_unresolved` is none. */
      unidentified: number[];
      /** Passing, but recorded at or before the issue's latest reopen: not current evidence. */
      predateReopen: number[];
      inadmissible: number[];
      superseded: Array<{ criterion: number; note: string }>;
      uncorroborated: Array<{ criterion: number; note: string }>;
    };

export type SourceType = 'git' | 'storefront' | 'none' | null;

/**
 * The drafts a move into `awaiting_release` corroborates its storefront verdicts against, read
 * before the move takes its lock. Any other move reads none.
 */
export async function readMoveDrafts(
  issue: { id: string; projectId: string },
  to: IssueStatus,
): Promise<CurrentDrafts> {
  if (to !== 'awaiting_release') return NO_DRAFTS_READ;
  const workflowIds = draftWorkflowIds(await listCriteria(db, issue.id));
  return workflowIds.length > 0 ? readCurrentDrafts(issue.projectId, workflowIds) : NO_DRAFTS_READ;
}

function draftFinding(
  latest: NonNullable<CriterionWithVerdict['latest']>,
  source: SourceType,
): 'inadmissible' | 'superseded' | 'uncorroborated' | null {
  if (latest.identityKind !== 'storefront_draft') return null;
  if (source !== 'storefront') return 'inadmissible';
  if (latest.corroboration === 'corroborated') return null;
  return latest.corroboration === 'superseded' ? 'superseded' : 'uncorroborated';
}

/**
 * The gate's reading of a set of criteria and their latest verdicts. A verdict at or before
 * `reopenedAt` is evidence about a build the reopen rejected, never current.
 */
// cm:why a storefront draft stands in for a landed commit only where the work lives on a storefront
// (`source.type: "storefront"`), and only once the source read the draft back (ISS-91).
export function evaluateCriteria(
  criteria: readonly CriterionWithVerdict[],
  reopenedAt: Date | null = null,
  source: SourceType = null,
): CriteriaEvidence {
  if (criteria.length === 0) return { kind: 'no-criteria' };
  const unpassed: Array<{ criterion: number; verdict: string | null }> = [];
  const unidentified: number[] = [];
  const predateReopen: number[] = [];
  const inadmissible: number[] = [];
  const superseded: Array<{ criterion: number; note: string }> = [];
  const uncorroborated: Array<{ criterion: number; note: string }> = [];
  for (const { n, latest } of criteria) {
    if (!latest || !PASSING.has(latest.verdict)) {
      unpassed.push({ criterion: n, verdict: latest?.verdict ?? null });
      continue;
    }
    if (reopenedAt && new Date(latest.createdAt).getTime() <= reopenedAt.getTime()) {
      predateReopen.push(n);
      continue;
    }
    if (latest.identityKind === null || latest.identityKind === 'commit_unresolved') {
      unidentified.push(n);
      continue;
    }
    const draft = draftFinding(latest, source);
    if (draft === 'inadmissible') inadmissible.push(n);
    const note = { criterion: n, note: latest.corroborationNote ?? 'no reading recorded' };
    if (draft === 'superseded') superseded.push(note);
    if (draft === 'uncorroborated') uncorroborated.push(note);
  }
  return {
    kind: 'criteria',
    unpassed,
    unidentified,
    predateReopen,
    inadmissible,
    superseded,
    uncorroborated,
  };
}

/**
 * When each issue last entered `reopen`, read from the move history (`kernel_transitions`); an
 * issue never reopened is absent. A verdict at or before that instant is not current evidence:
 * the release gate refuses it (`VERDICT_PREDATES_REOPEN`) and a coverage reader should too.
 */
export async function reopenedAtOf(
  executor: Pick<Tx, 'execute'>,
  issueIds: readonly string[],
): Promise<Map<string, Date>> {
  if (issueIds.length === 0) return new Map();
  const rows = (await executor.execute(sql`
    SELECT entity_id, max(created_at) AS at
      FROM kernel_transitions
     WHERE entity = 'issue'
       AND to_status = 'reopen'
       AND entity_id IN (${sql.join(
         issueIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
     GROUP BY entity_id`)) as unknown as Array<{ entity_id: string; at: Date | string }>;
  return new Map([...rows].map((r) => [r.entity_id, new Date(r.at)]));
}

export async function unpassedCriteria(
  executor: Pick<Tx, 'execute'>,
  issue: { id: string; projectId: string },
  source: SourceType,
  drafts: CurrentDrafts,
): Promise<CriteriaEvidence & { reopenedAt: Date | null }> {
  // Sequential: inside the transition's transaction both reads share one connection.
  const criteria = withDrafts(await listCriteria(executor, issue.id), drafts);
  const reopened = await reopenedAtOf(executor, [issue.id]);
  const reopenedAt = reopened.get(issue.id) ?? null;
  return { ...evaluateCriteria(criteria, reopenedAt, source), reopenedAt };
}
