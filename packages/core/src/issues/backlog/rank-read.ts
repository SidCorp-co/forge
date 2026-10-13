/**
 * The ordering of a project's takeable issues, read from stored scores (ISS-1336).
 *
 * A call reads: it catches up what is pending inside a budget, checks the index covers every
 * takeable issue, and answers best-first. Three things are said rather than absorbed. An index
 * that does not cover the backlog is refused by name. A change the index has not caught up with is
 * named stale. A weight table the project stored that cannot rank is refused with the key at fault.
 *
 * Eligibility is read from the live tables at query time, never stored: whether an edge still
 * holds an issue back is the master's own rule (`live-blockers-sql.ts`), and a stored copy of it
 * would be one more thing to be stale.
 */

import { sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../../db/client.js';
import { issueRefFormatter } from '../issue-prefix-read.js';
import { hasLiveBlockerSql, liveBlockerRowsSql } from '../live-blockers-sql.js';
import { catchUpRank } from './index-catch-up.js';
import { pendingFor } from './index-dirty.js';
import { type IndexExecutor, rowsOf, TAKEABLE_STATUSES, textList, uuidArray } from './index-sql.js';
import { loadRankContext, type RankContext } from './rank-context.js';
import { ageTermOf, type RankPart, withAge } from './rank-score.js';
import type { RankWeights } from './rank-weights.js';

export const RANKING_LIMIT_MAX = 500;
export const RANKING_LIMIT_DEFAULT = 100;

/** The terms and claims a caller still owes: named so that leaving them out is a stated absence. */
export const RANK_EXCLUDED: ReadonlyArray<{ term: string; why: string }> = [
  {
    term: 'reading',
    why: "read off one checkout's review mark, which no server can see; the caller adds it from `weights.value.reading`",
  },
  {
    term: 'prose edges',
    why: 'a dependency sentence in an issue body is a claim the tracker does not hold; only tracker `blocks` edges are chained and gate',
  },
];

export interface RankedIssue {
  issueId: string;
  displayId: string;
  title: string;
  status: string;
  priority: string;
  category: string | null;
  complexity: string | null;
  createdAt: string;
  score: { total: number; parts: RankPart[] };
  chained: number;
  eligible: boolean;
  blockedBy: Array<{
    issueId: string;
    displayId: string;
    status: string;
    holdsUntil: string;
    validUntil: string | null;
  }>;
  /** The session lease the issue carries, reported and never a reason to leave the row out. */
  lease: {
    holder: string | null;
    renewedAt: string | null;
    minutes: number | null;
    live: boolean;
  } | null;
}

export interface IndexState {
  state: 'fresh' | 'stale';
  /** Marks waiting for a drain. */
  pending: number;
  /** Scores whose chain walked an edge that has since lapsed; the ranking's alone. */
  lapsed?: number;
  oldestPendingAt: string | null;
}

export interface RankingAnswer {
  order: RankedIssue[];
  /** Every takeable issue, and how many of them no live edge holds back. */
  takeable: number;
  eligible: number;
  weights: { value: RankWeights; from: 'built-in' | 'project' };
  index: IndexState;
  edges: 'tracker';
  excluded: ReadonlyArray<{ term: string; why: string }>;
}

export class BacklogIndexRefused extends HTTPException {
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(409, { message, cause: { code, details } });
  }
}

export interface RankingQuery {
  projectId: string;
  limit: number;
  /** Leave out issues a live blocking edge holds back. */
  eligibleOnly: boolean;
  /** How long a read may spend catching up what is pending before it answers; 0 answers as the index stands. */
  catchUpMs: number;
}

interface Lease {
  holder?: unknown;
  renewedAt?: unknown;
  minutes?: unknown;
}

function leaseOf(raw: unknown, now: Date): RankedIssue['lease'] {
  const lease = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Lease | null;
  if (!lease || typeof lease !== 'object') return null;
  const renewedAt = typeof lease.renewedAt === 'string' ? lease.renewedAt : null;
  const minutes = typeof lease.minutes === 'number' ? lease.minutes : null;
  const ends =
    renewedAt !== null && minutes !== null ? Date.parse(renewedAt) + minutes * 60_000 : Number.NaN;
  return {
    holder: typeof lease.holder === 'string' ? lease.holder : null,
    renewedAt,
    minutes,
    live: Number.isFinite(ends) && ends > now.getTime(),
  };
}

const ageSql = (weights: RankWeights) => {
  const days = sql`GREATEST(0, floor(extract(epoch FROM (now() - i.created_at)) / 86400))`;
  const aged = sql`${days} * ${weights.agePerDay}::double precision`;
  return weights.ageCap === null ? aged : sql`LEAST(${aged}, ${weights.ageCap}::double precision)`;
};

function weightsRefused(projectId: string, context: RankContext): BacklogIndexRefused {
  return new BacklogIndexRefused('RANK_WEIGHTS_REFUSED', context.refusal ?? '', {
    projectId,
    weights: context.from,
  });
}

export async function readRanking(query: RankingQuery): Promise<RankingAnswer> {
  const { projectId } = query;
  const before = await loadRankContext(db, projectId);
  if (before.refusal) throw weightsRefused(projectId, before);
  await catchUpRank(projectId, query.catchUpMs, before.hash);
  const refOf = await issueRefFormatter(projectId);
  // One snapshot for every read below: a writer committing between the coverage check, the pending
  // count and the rows would otherwise be served as an index that was fresh and whole.
  return db.transaction((tx) => answerFrom(tx, query, refOf), {
    isolationLevel: 'repeatable read',
    accessMode: 'read only',
  });
}

async function answerFrom(
  executor: IndexExecutor,
  query: RankingQuery,
  refOf: (seq: number) => string,
): Promise<RankingAnswer> {
  const { projectId } = query;
  const context = await loadRankContext(executor, projectId);
  if (context.refusal) throw weightsRefused(projectId, context);

  const covered = await coverageOf(executor, projectId, context.hash);
  if (covered.missing > 0) {
    const sample = covered.unscored.join(', ');
    const other = covered.underOtherWeights;
    throw new BacklogIndexRefused(
      'RANK_INDEX_INCOMPLETE',
      `the ranking index does not cover this backlog: ${covered.missing} of ${covered.takeable} takeable ` +
        `issue(s) have no score under the weights in force (${other} scored under previous weights), ` +
        `for example ${sample}. No ordering is served over a part of the backlog; the index is being ` +
        'brought up to date, so ask again.',
      {
        projectId,
        takeable: covered.takeable,
        unscored: covered.missing,
        underPreviousWeights: other,
        issues: covered.unscored,
      },
    );
  }

  const now = new Date();
  const [pending, lapsed] = await Promise.all([
    pendingFor(executor, projectId, ['rank']),
    lapsedScores(executor, projectId),
  ]);
  const stale = pending.pending + lapsed > 0;

  const blocked = () => hasLiveBlockerSql(projectId, sql`i.id`);
  const rows = await rowsOf(
    executor,
    sql`
    SELECT i.id::text AS id, i.iss_seq, i.title, i.status, i.priority, i.category, i.complexity,
           i.created_at, i.session_context -> 'lease' AS lease,
           s.static_score, s.parts, s.chain_count,
           GREATEST(0, floor(extract(epoch FROM (now() - i.created_at)) / 86400))::int AS age_days,
           ${blocked()} AS blocked
      FROM issue_rank_scores s
      JOIN issues i ON i.id = s.issue_id
     WHERE s.project_id = ${projectId}::uuid AND s.weights_hash = ${context.hash}
       AND i.archived_at IS NULL AND i.status IN (${textList(TAKEABLE_STATUSES)})
       ${query.eligibleOnly ? sql`AND NOT ${blocked()}` : sql``}
     ORDER BY (s.static_score + ${ageSql(context.weights)}) DESC, i.created_at ASC, i.iss_seq ASC
     LIMIT ${query.limit}`,
  );

  const blockers = await blockersFor(
    executor,
    projectId,
    rows.filter((row) => row.blocked === true).map((row) => String(row.id)),
    refOf,
  );

  const order: RankedIssue[] = rows.map((row) => {
    const days = Number(row.age_days);
    const age = ageTermOf(days, context.weights);
    const parts = withAge(row.parts as RankPart[], age);
    const held = blockers.get(String(row.id)) ?? [];
    return {
      issueId: String(row.id),
      displayId: refOf(Number(row.iss_seq)),
      title: String(row.title),
      status: String(row.status),
      priority: String(row.priority),
      category: row.category === null ? null : String(row.category),
      complexity: row.complexity === null ? null : String(row.complexity),
      createdAt: new Date(String(row.created_at)).toISOString(),
      score: { total: Number(row.static_score) + age.points, parts },
      chained: Number(row.chain_count),
      eligible: row.blocked !== true,
      blockedBy: held,
      lease: leaseOf(row.lease, now),
    };
  });

  const counts = await takeableCounts(executor, projectId);
  return {
    order,
    takeable: counts.takeable,
    eligible: counts.eligible,
    weights: { value: context.weights, from: context.from },
    index: {
      state: stale ? 'stale' : 'fresh',
      pending: pending.pending,
      lapsed,
      oldestPendingAt: pending.oldestMarkedAt ? pending.oldestMarkedAt.toISOString() : null,
    },
    edges: 'tracker',
    excluded: RANK_EXCLUDED,
  };
}

async function coverageOf(executor: IndexExecutor, projectId: string, hash: string) {
  const rows = await rowsOf(
    executor,
    sql`
    SELECT i.iss_seq, s.issue_id IS NOT NULL AS under_other
      FROM issues i
      LEFT JOIN issue_rank_scores s ON s.issue_id = i.id
     WHERE i.project_id = ${projectId}::uuid AND i.archived_at IS NULL
       AND i.status IN (${textList(TAKEABLE_STATUSES)})
       AND (s.issue_id IS NULL OR s.weights_hash <> ${hash})
     ORDER BY i.iss_seq`,
  );
  const [total] = await rowsOf(
    executor,
    sql`SELECT count(*)::int AS n FROM issues
         WHERE project_id = ${projectId}::uuid AND archived_at IS NULL
           AND status IN (${textList(TAKEABLE_STATUSES)})`,
  );
  const refOf = await issueRefFormatter(projectId);
  return {
    takeable: Number(total?.n ?? 0),
    missing: rows.length,
    underOtherWeights: rows.filter((row) => row.under_other === true).length,
    unscored: rows.slice(0, 20).map((row) => refOf(Number(row.iss_seq))),
  };
}

async function lapsedScores(executor: IndexExecutor, projectId: string): Promise<number> {
  const [row] = await rowsOf(
    executor,
    sql`SELECT count(*)::int AS n FROM issue_rank_scores
         WHERE project_id = ${projectId}::uuid AND fresh_until IS NOT NULL AND fresh_until <= now()`,
  );
  return Number(row?.n ?? 0);
}

async function takeableCounts(executor: IndexExecutor, projectId: string) {
  const [row] = await rowsOf(
    executor,
    sql`SELECT count(*)::int AS takeable,
               count(*) FILTER (WHERE NOT ${hasLiveBlockerSql(projectId, sql`i.id`)})::int AS eligible
          FROM issues i
         WHERE i.project_id = ${projectId}::uuid AND i.archived_at IS NULL
           AND i.status IN (${textList(TAKEABLE_STATUSES)})`,
  );
  return { takeable: Number(row?.takeable ?? 0), eligible: Number(row?.eligible ?? 0) };
}

async function blockersFor(
  executor: IndexExecutor,
  projectId: string,
  dependentIds: readonly string[],
  refOf: (seq: number) => string,
): Promise<Map<string, RankedIssue['blockedBy']>> {
  const out = new Map<string, RankedIssue['blockedBy']>();
  if (dependentIds.length === 0) return out;
  const rows = await rowsOf(
    executor,
    sql`
    SELECT d.to_issue_id::text AS dependent, b.id::text AS blocker, b.iss_seq, b.status,
           d.holds_until, d.valid_until
    ${liveBlockerRowsSql(projectId, sql`= ANY(${uuidArray(dependentIds)})`)}
     ORDER BY b.iss_seq`,
  );
  for (const row of rows) {
    const held = out.get(String(row.dependent)) ?? [];
    held.push({
      issueId: String(row.blocker),
      displayId: refOf(Number(row.iss_seq)),
      status: String(row.status),
      holdsUntil: String(row.holds_until),
      validUntil: row.valid_until ? new Date(String(row.valid_until)).toISOString() : null,
    });
    out.set(String(row.dependent), held);
  }
  return out;
}
