/**
 * The one place a screen reads the database.
 *
 * Everything a rule is judged against is gathered here, once per screen, and
 * only where a rule in the cell asked for it — a cell with no claim rule in it
 * makes no query at all.
 */

import { and, eq, inArray, or } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { issues } from '../db/schema.js';
import { activeIssuePrefix, heldIssuePrefixes } from '../issues/issue-prefix-read.js';
import { computeProjectProgress } from '../issues/progress.js';
import { LEGACY_ISSUE_PREFIX } from '../lib/issue-ref.js';
import { cellFor } from './cells.js';
import type { Audience, FactKind, Intent } from './contract.js';
import { type IssueRow, type MessageFacts, NO_FACTS, type ProgressFacts } from './facts.js';
import { extractIssueClaims } from './issue-tokens.js';

export interface GatherInput {
  readonly projectId: string;
  readonly audience: Audience;
  readonly intent: Intent;
  readonly segments: readonly string[];
  readonly toolCalls?: readonly { name: string; arguments: string }[];
  /**
   * The snapshot the writer's own turn was shown. `'compute'` re-queries, and is
   * only for a caller that has none to pass.
   */
  readonly progress?: ProgressFacts | null | 'compute';
  /**
   * The handle to read through. A caller inside a transaction MUST pass its own.
   */
  // cm:guard reading the pool from inside a caller's transaction is a deadlock, not a style point: the pool is ten wide, `insertComment` runs this before its own insert, and a caller holding one connection while waiting for a second means ten concurrent writers wait on each other until they time out (the same hazard `loadStageContext` carries, ISS-981).
  readonly executor?: Tx;
}

// cm:why a reference-shaped token in ANY prefix, checked before the prefix query rather than after: both rules that read the tracker need a reference, so a body carrying none needs no lookup at all — and finding out otherwise would cost the two queries this skips. It is deliberately wider than the project's own prefixes, so it can only skip work the rules would have found nothing in.
const ANY_REFERENCE_RE = /\b[A-Za-z][A-Za-z0-9]{1,5}-\d{1,6}\b/;

function needsOf(audience: Audience, intent: Intent): Set<FactKind> {
  const cell = cellFor(audience, intent);
  const needs = new Set<FactKind>();
  for (const rule of cell?.rules ?? []) for (const n of rule.needs) needs.add(n);
  return needs;
}

interface Cited {
  readonly ids: string[];
  readonly seqs: number[];
}

function cited(segments: readonly string[], prefixes: readonly string[]): Cited {
  const ids = new Set<string>();
  const seqs = new Set<number>();
  for (const s of segments) {
    const claims = extractIssueClaims(s ?? '', prefixes);
    for (const id of claims.urlIds) ids.add(id);
    for (const seq of claims.issSeqs) seqs.add(seq);
  }
  return { ids: [...ids], seqs: [...seqs] };
}

// cm:guard the lookup fails OPEN, and the flag rather than an empty result is what says so: an empty `issueRows` is indistinguishable from "this project holds none of them", which would turn a database blip into a refusal of every message that names an issue. The rules read `issueLookupFailed` and stand down.
async function issueRowsFor(
  projectId: string,
  c: Cited,
  tx: Tx,
): Promise<{ rows: Map<number, IssueRow>; ids: Set<string>; failed: boolean }> {
  const empty = { rows: new Map<number, IssueRow>(), ids: new Set<string>(), failed: false };
  if (c.ids.length === 0 && c.seqs.length === 0) return empty;
  try {
    const conds = [
      ...(c.ids.length > 0 ? [inArray(issues.id, c.ids)] : []),
      ...(c.seqs.length > 0 ? [inArray(issues.issSeq, c.seqs)] : []),
    ];
    const found = await tx
      .select({
        id: issues.id,
        issSeq: issues.issSeq,
        status: issues.status,
        mergedAt: issues.mergedAt,
      })
      .from(issues)
      .where(and(eq(issues.projectId, projectId), or(...conds)));
    const rows = new Map<number, IssueRow>();
    for (const r of found) {
      rows.set(r.issSeq, { seq: r.issSeq, merged: r.mergedAt !== null, status: r.status });
    }
    return { rows, ids: new Set(found.map((r) => r.id)), failed: false };
  } catch {
    return { ...empty, failed: true };
  }
}

/**
 * The prefixes a claim in this project's comments may be written in.
 */
// cm:guard `LEGACY_ISSUE_PREFIX` is folded in whenever the project stores no prefix of its own, because a NULL `projects.issue_prefix` is not "no prefix" — `formatIssueRef` renders that project's issues as `ISS-n` and its own agents write `ISS-n` back. Reading the column literally made the status rule abstain on every project that never set one, which is most of them: the screen would have passed `ISS-997 is merged` in silence while reporting itself green (found by the ISS-997 integration lane, where a fresh project has no prefix).
// cm:edge contract -> packages/core/src/lib/issue-ref.ts — `formatIssueRef` is the renderer this mirrors. The two must agree on what a null column means, or the screen judges a key nobody writes and ignores the one everybody does.
async function activePrefixes(
  projectId: string,
  tx: Tx,
): Promise<[string | null, readonly string[]]> {
  const [active, held] = await Promise.all([
    activeIssuePrefix(projectId, tx),
    heldIssuePrefixes(projectId, tx),
  ]);
  const prefix = active ?? LEGACY_ISSUE_PREFIX;
  return [prefix, [...new Set([prefix, ...held])]];
}

/** Everything the cell's rules need, and nothing they do not. */
export async function gatherFacts(input: GatherInput): Promise<MessageFacts> {
  const needs = needsOf(input.audience, input.intent);
  const tx = input.executor ?? db;
  const base: MessageFacts = {
    ...NO_FACTS,
    toolCalls: input.toolCalls ?? [],
  };
  if (needs.size === 0) return base;
  if (needs.size === 1 && needs.has('issue-rows')) return base;
  const mentionsOne = input.segments.some((s) => ANY_REFERENCE_RE.test(s ?? ''));
  if (!needs.has('progress') && !mentionsOne) return base;

  const [prefix, prefixes] = needs.has('prefixes')
    ? await activePrefixes(input.projectId, tx)
    : [null, [] as readonly string[]];

  const issueFacts = needs.has('issue-rows')
    ? await issueRowsFor(input.projectId, cited(input.segments, prefixes), tx)
    : { rows: new Map<number, IssueRow>(), ids: new Set<string>(), failed: false };

  // cm:guard `tx` reaches the progress read too, and not only the two above it. A caller that supplied an executor is inside a transaction holding one of ten pooled connections, and a read here on the pool would have it wait for a second — the deadlock `loadStageContext` names (ISS-981). No cell needing progress is screened inside a transaction TODAY, which is exactly why this was missed; the executor's contract is what must hold, not the current call graph.
  const progress = needs.has('progress')
    ? input.progress === 'compute'
      ? await computeProjectProgress(input.projectId, tx)
      : (input.progress ?? null)
    : null;

  return {
    ...base,
    prefix,
    prefixes,
    knownIssueIds: issueFacts.ids,
    knownIssueSeqs: new Set(issueFacts.rows.keys()),
    issueRows: issueFacts.rows,
    issueLookupFailed: issueFacts.failed,
    progress,
  };
}
