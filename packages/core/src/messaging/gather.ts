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
  readonly executor?: Tx;
}

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
