/**
 * Archiving an issue (ISS-1237): out of every discovery read, still answered by key, reversible.
 *
 * The read side is two predicates. `issueArchiveSide` is what every read that lists or searches
 * issues composes, the shape `projects/routes.ts` already has. `memoryOfLiveIssue` is its twin for
 * the memory corpus, where each issue lives again as a `memories` row with `source = 'issue'` and
 * `source_ref = issues.id`; that corpus is what recall, the alike check and knowledge search read,
 * so a filter on `issues` alone would leave the text reachable. The memory rows themselves are not
 * archived: `memories.archived_at` is decay's soft delete, followed by a hard purge.
 *
 * The write side is one operation over a filter, in either direction, with a dry run. A row that
 * is not terminal, or that a non-terminal issue still points at, is refused by name and the whole
 * call writes nothing: hiding it would leave live work, or an edge, pointing at a row no reader
 * can see.
 */

import { and, eq, inArray, isNull, lt, notInArray, or, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  activityLog,
  type IssueStatus,
  issueDependencies,
  issueStatuses,
  issues,
  memories,
} from '../db/schema.js';
import { issueRefNeedsHeldPrefixes, parseIssueRef } from '../lib/issue-ref.js';
import type { Actor } from '../pipeline/activity.js';
import { heldIssuePrefixes, issueRefFormatter } from './issue-prefix-read.js';
import { ISSUE_TERMINAL_STATUSES } from './status-sets.js';

/** The condition a discovery read composes: nothing when the caller asked for archived rows too. */
export function issueArchiveSide(includeArchived: boolean | undefined): SQL[] {
  return includeArchived ? [] : [isNull(issues.archivedAt)];
}

const archivedIssueIds = (projectId: string) =>
  sql`(SELECT ai.id::text FROM issues ai WHERE ai.project_id = ${projectId} AND ai.archived_at IS NOT NULL)`;

/**
 * A memory row that is not the text of an archived issue. `NOT IN` over the project's archived
 * ids is a hashed subplan, evaluated once per query rather than once per memory row.
 */
export function memoryOfLiveIssue(projectId: string): SQL {
  return sql`(${memories.source} <> 'issue' OR ${memories.sourceRef} NOT IN ${archivedIssueIds(projectId)})`;
}

/** The same condition for hand-written SQL that names the memories table by an alias. */
export function memoryOfLiveIssueAs(tableAlias: string, projectId: string): SQL {
  const t = sql.raw(tableAlias);
  return sql`(${t}.source <> 'issue' OR ${t}.source_ref NOT IN ${archivedIssueIds(projectId)})`;
}

const refList = z.array(z.string().trim().min(1).max(40)).max(10_000);

export const issueArchiveFilterSchema = z
  .object({
    keys: refList.min(1).optional(),
    statuses: z.array(z.enum(issueStatuses)).min(1).optional(),
    seqBelow: z.number().int().positive().optional(),
    exclude: refList.optional(),
  })
  .strict()
  .refine((f) => f.keys !== undefined || f.statuses !== undefined, {
    message:
      'the filter needs `keys` or `statuses`: with neither it would match every issue in the project',
  });

export const issueArchiveRequestSchema = z
  .object({ filter: issueArchiveFilterSchema, dryRun: z.boolean().optional() })
  .strict();

export type IssueArchiveFilter = z.infer<typeof issueArchiveFilterSchema>;
export type ArchiveDirection = 'archive' | 'unarchive';

export type IssueArchiveRefusal =
  | { kind: 'unknown_key'; field: 'keys' | 'exclude'; key: string; message: string }
  | { kind: 'status_not_terminal'; status: IssueStatus; message: string }
  | { kind: 'not_terminal'; key: string; status: IssueStatus; message: string }
  | {
      kind: 'load_bearing_edge';
      key: string;
      edgeId: string;
      edgeKind: string;
      direction: 'outgoing' | 'incoming';
      other: string;
      otherStatus: IssueStatus;
      message: string;
    };

export type IssueArchiveReport = {
  direction: ArchiveDirection;
  dryRun: boolean;
  /** Every key the filter matched, in sequence order. */
  matched: string[];
  /** Keys named in `keys` that the other fields of the filter left out. */
  unmatchedKeys: string[];
  /** The rows this call changed, or on a dry run the rows it would change. */
  changed: string[];
  /** Matched rows already on the side this call moves them to. */
  unchanged: string[];
  refusals: IssueArchiveRefusal[];
};

export class IssueArchiveRefusedError extends Error {
  readonly code = 'ARCHIVE_REFUSED';
  constructor(readonly report: IssueArchiveReport) {
    super(
      `${report.direction} refused, nothing was written: ${report.refusals
        .slice(0, 5)
        .map((r) => r.message)
        .join(
          '; ',
        )}${report.refusals.length > 5 ? `; and ${report.refusals.length - 5} more` : ''}`,
    );
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Row = { id: string; issSeq: number; status: IssueStatus; archivedAt: Date | null };

async function resolveRefs(
  projectId: string,
  field: 'keys' | 'exclude',
  refs: readonly string[] | undefined,
  refusals: IssueArchiveRefusal[],
): Promise<Map<number, string>> {
  const seqs = new Map<number, string>();
  if (!refs) return seqs;
  const held = refs.some(issueRefNeedsHeldPrefixes) ? await heldIssuePrefixes(projectId) : [];
  for (const ref of refs) {
    const parsed = parseIssueRef(ref, held);
    if (parsed.ok) seqs.set(parsed.issSeq, ref);
    else refusals.push({ kind: 'unknown_key', field, key: ref, message: parsed.message });
  }
  if (seqs.size === 0) return seqs;
  const found = await db
    .select({ issSeq: issues.issSeq })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), inArray(issues.issSeq, [...seqs.keys()])));
  const present = new Set(found.map((r) => r.issSeq));
  for (const [seq, ref] of seqs) {
    if (present.has(seq)) continue;
    seqs.delete(seq);
    refusals.push({
      kind: 'unknown_key',
      field,
      key: ref,
      message: `\`${ref}\` in \`filter.${field}\` names no issue in this project`,
    });
  }
  return seqs;
}

function matchedWhere(
  projectId: string,
  filter: IssueArchiveFilter,
  keys: number[],
  exclude: number[],
) {
  const conds: SQL[] = [eq(issues.projectId, projectId)];
  if (filter.keys) conds.push(inArray(issues.issSeq, keys.length > 0 ? keys : [-1]));
  if (filter.statuses) conds.push(inArray(issues.status, filter.statuses));
  if (filter.seqBelow !== undefined) conds.push(lt(issues.issSeq, filter.seqBelow));
  if (exclude.length > 0) conds.push(notInArray(issues.issSeq, exclude));
  return and(...conds);
}

/** Every unexpired edge from a matched row to an issue that is not over, in both directions. */
async function loadBearingEdges(
  tx: Tx,
  projectId: string,
  rows: Row[],
  keyOf: (seq: number) => string,
) {
  const ids = rows.map((r) => r.id);
  const seqById = new Map(rows.map((r) => [r.id, r.issSeq]));
  const other = alias(issues, 'other_side');
  const live = or(
    isNull(issueDependencies.validUntil),
    sql`${issueDependencies.validUntil} > now()`,
  );
  const refusals: IssueArchiveRefusal[] = [];
  for (const direction of ['outgoing', 'incoming'] as const) {
    const mine =
      direction === 'outgoing' ? issueDependencies.fromIssueId : issueDependencies.toIssueId;
    const theirs =
      direction === 'outgoing' ? issueDependencies.toIssueId : issueDependencies.fromIssueId;
    const edges = await tx
      .select({
        edgeId: issueDependencies.id,
        edgeKind: issueDependencies.kind,
        mine,
        otherSeq: other.issSeq,
        otherStatus: other.status,
      })
      .from(issueDependencies)
      .innerJoin(other, eq(other.id, theirs))
      .where(
        and(
          eq(issueDependencies.projectId, projectId),
          inArray(mine, ids),
          live,
          notInArray(other.status, [...ISSUE_TERMINAL_STATUSES]),
        ),
      );
    for (const e of edges) {
      const key = keyOf(seqById.get(e.mine) ?? 0);
      const otherKey = keyOf(e.otherSeq);
      const verb = direction === 'outgoing' ? `${e.edgeKind} →` : `← ${e.edgeKind} from`;
      refusals.push({
        kind: 'load_bearing_edge',
        key,
        edgeId: e.edgeId,
        edgeKind: e.edgeKind,
        direction,
        other: otherKey,
        otherStatus: e.otherStatus,
        message: `${key} is still load-bearing: edge ${e.edgeId} (${key} ${verb} ${otherKey}, which is \`${e.otherStatus}\`). Retract the edge, finish ${otherKey}, or leave ${key} out with \`filter.exclude\``,
      });
    }
  }
  return refusals;
}

function refuseForArchive(rows: Row[], keyOf: (seq: number) => string): IssueArchiveRefusal[] {
  return rows
    .filter((r) => !ISSUE_TERMINAL_STATUSES.includes(r.status))
    .map((r) => ({
      kind: 'not_terminal' as const,
      key: keyOf(r.issSeq),
      status: r.status,
      message: `${keyOf(r.issSeq)} is \`${r.status}\`: only a \`closed\` or \`dropped\` issue can be archived, because an archived issue is out of every list that live work is found in`,
    }));
}

async function writeSide(
  tx: Tx,
  input: {
    direction: ArchiveDirection;
    projectId: string;
    filter: IssueArchiveFilter;
    actor: Actor;
  },
  rows: Row[],
) {
  const { direction, projectId, filter, actor } = input;
  if (rows.length === 0) return;
  const ids = rows.map((r) => r.id);
  await tx
    .update(issues)
    .set({
      archivedAt: direction === 'archive' ? sql`coalesce(${issues.archivedAt}, now())` : null,
    })
    .where(and(eq(issues.projectId, projectId), inArray(issues.id, ids)));
  await tx.insert(activityLog).values(
    rows.map((r) => ({
      issueId: r.id,
      actorType: actor.type,
      actorId: actor.id,
      actorAgency: actor.agency,
      action: direction === 'archive' ? 'issue.archived' : 'issue.unarchived',
      payload: {
        filter,
        ...(direction === 'unarchive' ? { archivedAt: r.archivedAt?.toISOString() ?? null } : {}),
      },
    })),
  );
}

/**
 * Archive or unarchive the issues a filter matches. A dry run answers the same report and writes
 * nothing. A run with any refusal throws `IssueArchiveRefusedError` carrying every refusal, and
 * writes nothing either. The matched rows are locked `FOR UPDATE`, which serialises this against a
 * status transition and an edge write naming the same rows.
 */
export async function runIssueArchive(input: {
  projectId: string;
  direction: ArchiveDirection;
  filter: IssueArchiveFilter;
  dryRun: boolean;
  actor: Actor;
}): Promise<IssueArchiveReport> {
  const { projectId, direction, filter, dryRun, actor } = input;
  const refusals: IssueArchiveRefusal[] = [];
  const keySeqs = await resolveRefs(projectId, 'keys', filter.keys, refusals);
  const excludeSeqs = await resolveRefs(projectId, 'exclude', filter.exclude, refusals);
  if (direction === 'archive') {
    for (const status of filter.statuses ?? []) {
      if (ISSUE_TERMINAL_STATUSES.includes(status)) continue;
      refusals.push({
        kind: 'status_not_terminal',
        status,
        message: `\`filter.statuses\` names \`${status}\`: only \`closed\` and \`dropped\` issues can be archived`,
      });
    }
  }
  const keyOf = await issueRefFormatter(projectId);

  return db.transaction(async (tx) => {
    const rows: Row[] = await tx
      .select({
        id: issues.id,
        issSeq: issues.issSeq,
        status: issues.status,
        archivedAt: issues.archivedAt,
      })
      .from(issues)
      .where(matchedWhere(projectId, filter, [...keySeqs.keys()], [...excludeSeqs.keys()]))
      .orderBy(issues.issSeq)
      .for('update');

    if (direction === 'archive' && rows.length > 0) {
      refusals.push(...refuseForArchive(rows, keyOf));
      refusals.push(...(await loadBearingEdges(tx, projectId, rows, keyOf)));
    }

    const matchedSeqs = new Set(rows.map((r) => r.issSeq));
    const toMove = rows.filter((r) => (direction === 'archive') === (r.archivedAt === null));
    const report: IssueArchiveReport = {
      direction,
      dryRun,
      matched: rows.map((r) => keyOf(r.issSeq)),
      unmatchedKeys: [...keySeqs.keys()].filter((s) => !matchedSeqs.has(s)).map(keyOf),
      changed: toMove.map((r) => keyOf(r.issSeq)),
      unchanged: rows.filter((r) => !toMove.includes(r)).map((r) => keyOf(r.issSeq)),
      refusals,
    };
    if (dryRun) return report;
    if (refusals.length > 0) throw new IssueArchiveRefusedError(report);
    await writeSide(tx, { direction, projectId, filter, actor }, toMove);
    return report;
  });
}

/** The refusal an edge write or a transition gets when it names an archived issue. */
export function archivedIssueSentence(key: string, projectId: string): string {
  return `${key} is archived. Unarchive it first — POST /api/projects/${projectId}/issues/unarchive with {"filter":{"keys":["${key}"]}} — then retry`;
}

/**
 * The archived issues among `issueIds`, each with the sentence that refuses a write naming it.
 * `lock` takes the rows `FOR UPDATE` (a transition) or `FOR SHARE` (an edge write), either of which
 * waits on an archive holding them and then reads what it committed. Without it this is a plain
 * read, for a refusal owed before any other check runs.
 */
export async function archivedAmong(
  ex: Pick<Tx, 'select'>,
  issueIds: readonly string[],
  lock?: 'update' | 'share',
): Promise<Array<{ issueId: string; key: string; message: string }>> {
  if (issueIds.length === 0) return [];
  const read = ex
    .select({
      id: issues.id,
      projectId: issues.projectId,
      issSeq: issues.issSeq,
      archivedAt: issues.archivedAt,
    })
    .from(issues)
    .where(inArray(issues.id, [...issueIds]));
  const rows = lock ? await read.for(lock) : await read;
  const archived = rows.filter((r) => r.archivedAt !== null);
  const out: Array<{ issueId: string; key: string; message: string }> = [];
  for (const r of archived) {
    const key = (await issueRefFormatter(r.projectId))(r.issSeq);
    out.push({ issueId: r.id, key, message: archivedIssueSentence(key, r.projectId) });
  }
  return out;
}
