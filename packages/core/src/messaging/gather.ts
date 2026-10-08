/**
 * The one place a screen reads the database.
 *
 * Everything a rule is judged against is gathered here, once per screen, and
 * only where a rule in the cell asked for it — a cell with no claim rule in it
 * makes no query at all.
 */

import { db, type Tx } from '../db/client.js';
import { LEGACY_ISSUE_PREFIX } from '../lib/issue-ref.js';
import { logger } from '../lib/logger.js';
import { cellFor } from './cells.js';
import type { Audience, FactKind, Intent } from './contract.js';
import {
  type FigureFacts,
  type IssueRow,
  type MessageFacts,
  NO_FACTS,
  type ProgressFacts,
} from './facts.js';
import { askedValues } from './figure-exemptions.js';
import { figureFactsOf, runIdsIn } from './figures-rule.js';
import { extractIssueClaims } from './issue-tokens.js';
import { messageReads } from './reads.js';

interface GatherInput {
  readonly projectId: string;
  readonly audience: Audience;
  readonly intent: Intent;
  readonly segments: readonly string[];
  readonly toolCalls?: readonly { name: string; arguments: string; isError?: boolean }[];
  readonly offeredTools?: readonly string[];
  /** The counts the writer's own reads returned (`facts.ts:MessageFacts`). */
  readonly readCounts?: ReadonlySet<number>;
  /** The dates the memories the writer read speak as of (`facts.ts:MessageFacts`). */
  readonly memoryDates?: ReadonlySet<string>;
  /** The snapshot the writer's own turn was shown. */
  readonly progress?: ProgressFacts | null;
  /**
   * Where the turn could run a report: what the person asked, and the texts its reads returned and
   * its calls sent, whose run ids name the runs a figure is held to. Absent, no figure is judged.
   */
  readonly figures?: {
    readonly asked: string;
    readonly texts: readonly string[];
    /** What the turn's grounding reads returned (`figures-rule.ts:groundingTexts`). */
    readonly reads?: readonly string[];
  };
  /** What the person asked: a number they typed is theirs, said back (`facts.ts:MessageFacts`). */
  readonly question?: string;
  /** The blocks held with this reply, as JSON (`facts.ts:MessageFacts`). */
  readonly heldBlocks?: readonly string[];
  /** The conversation the reply is posted in: the records agreed in it ground a claim (`facts.ts:MessageFacts`). */
  readonly conversationId?: string;
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
    const found = await messageReads().citedIssues(projectId, c, tx);
    const rows = new Map<number, IssueRow>();
    for (const r of found) {
      rows.set(r.issSeq, { seq: r.issSeq, merged: r.mergedAt !== null, status: r.status });
    }
    return { rows, ids: new Set(found.map((r) => r.id)), failed: false };
  } catch (err) {
    // the rules that need these rows hold the message naming themselves (claim-rules.ts:ISSUES_UNREAD)
    logger.error(
      { err, projectId },
      'message screen: the issues the message names could not be read',
    );
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
    messageReads().activeIssuePrefix(projectId, tx),
    messageReads().heldIssuePrefixes(projectId, tx),
  ]);
  const prefix = active ?? LEGACY_ISSUE_PREFIX;
  return [prefix, [...new Set([prefix, ...held])]];
}

/** The turn's report runs, read by the ids its texts name; null where the cell or the turn judges no figure. */
async function figureFactsFor(
  input: GatherInput,
  needs: ReadonlySet<FactKind>,
  tx: Tx,
): Promise<FigureFacts | null> {
  if (!needs.has('report-runs') || !input.figures) return null;
  const ids = runIdsIn(input.figures.texts);
  const frames =
    ids.length === 0 ? [] : await messageReads().reportRunFrames(input.projectId, ids, tx);
  return figureFactsOf(input.figures.asked, frames, input.figures.reads ?? []);
}

/** Everything the cell's rules need, and nothing they do not. */
export async function gatherFacts(input: GatherInput): Promise<MessageFacts> {
  const needs = needsOf(input.audience, input.intent);
  const tx = input.executor ?? db;
  const base: MessageFacts = {
    ...NO_FACTS,
    toolCalls: input.toolCalls ?? [],
    offeredTools: input.offeredTools ?? [],
    readCounts: input.readCounts ?? new Set(),
    memoryDates: input.memoryDates ?? new Set(),
    asked: input.question === undefined ? new Set() : askedValues(input.question),
    figures: await figureFactsFor(input, needs, tx),
    heldBlocks: input.heldBlocks ?? null,
    agreedRecords:
      needs.has('agreed-records') && input.conversationId
        ? await messageReads().agreedRecords(input.conversationId, tx)
        : [],
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

  const progress = needs.has('progress') ? (input.progress ?? null) : null;

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
