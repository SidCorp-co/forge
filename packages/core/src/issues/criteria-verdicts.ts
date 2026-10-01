// ISS-1117 — no per-criterion verdict table exists; this reads the `forge-record: verdict`
// fence convention already used in issue comments (parseForgeRecord), the same shape ISS-1114
// and ISS-1139 carry live today.

import { eq, inArray } from 'drizzle-orm';
import { listIssueComments } from '../comments/service.js';
import { db } from '../db/client.js';
import { commentAttachments, comments, issueAttachments, issues } from '../db/schema.js';
import { parseForgeRecord } from '../messaging/forge-record.js';
import { criterionBlocksIn, longestSpelling } from '../messaging/verdict-identity.js';
import type { ServingReading } from '../release-batch/serving-reading.js';
import { UNWEIGHED, type Weighing } from '../release-batch/weighing.js';
import { type CitationReport, citationSentence, unresolvedCitations } from './evidence-standing.js';
import {
  type OwedRuntimes,
  owedRuntimes,
  type WeighedVerdict,
  weighVerdict,
} from './runtime-standing.js';
import {
  EARNED_STANDINGS,
  type IssueIdentities,
  issueIdentities,
  standingSentence,
  type VerdictIdentity,
  type VerdictStanding,
} from './verdict-standing.js';

// `short` is the CLI's own "met short of its wording, judged not to block" — a real judgement.
const EARNED_VERDICTS: ReadonlySet<string> = new Set(['pass', 'short']);

/** The numbered top-level lines of an acceptance-criteria field, in order written. */
export function acceptanceCriteriaNumbers(text: string | null | undefined): number[] {
  const body = String(text ?? '');
  const found = new Set<number>();
  for (const match of body.matchAll(/^\s{0,3}(\d+)\.\s/gmu)) {
    const n = Number.parseInt(match[1] as string, 10);
    if (Number.isFinite(n)) found.add(n);
  }
  return [...found].sort((a, b) => a - b);
}

export interface CriterionVerdict {
  readonly criterion: number;
  readonly verdict: string;
  /** What this verdict names as the thing it held in, or null where it names none. */
  readonly at: VerdictIdentity | null;
  /** What this verdict cites as what it was taken from, in the order written. */
  readonly cited: readonly string[];
}

/** The (criterion, verdict, identity) triples one `verdict`-kind `forge-record` fence names. */
export function verdictPairsIn(body: string): CriterionVerdict[] {
  const out: CriterionVerdict[] = [];
  for (const block of criterionBlocksIn(parseForgeRecord(body))) {
    if (block.verdict === null) continue;
    const at: VerdictIdentity | null =
      block.runtime !== null
        ? { kind: 'runtime', value: block.runtime }
        : block.source !== null
          ? { kind: 'source', value: block.source }
          : null;
    out.push({ criterion: block.criterion, verdict: block.verdict, at, cited: block.cited });
  }
  return out;
}

// Read oldest-to-newest so a re-judged criterion overwrites the verdict before it.
export async function latestCriterionVerdicts(
  issueId: string,
): Promise<Map<number, CriterionVerdict>> {
  const rows = await listIssueComments(issueId);
  const latest = new Map<number, CriterionVerdict>();
  for (const row of rows) {
    for (const pair of verdictPairsIn(row.body)) {
      latest.set(pair.criterion, pair);
    }
  }
  return latest;
}

/** One criterion an issue does not carry an earned, standing verdict on. */
export interface UnearnedCriterion {
  readonly criterion: number;
  /** The latest verdict's word, or null where no verdict record has ever named this criterion. */
  readonly verdict: string | null;
  /** How that verdict's identity resolved, or null where there is no verdict. */
  readonly standing: VerdictStanding | null;
  readonly why: string;
}

/** One criterion whose verdict cites something the tracker cannot resolve, and which citation. */
export interface BrokenCitations {
  readonly criterion: number;
  readonly unresolved: readonly CitationReport[];
}

export interface IssueCriteriaReport {
  readonly issueId: string;
  readonly unearned: readonly UnearnedCriterion[];
  /** Named beside `unearned` so a reader gets the citation and not only the consequence. */
  readonly broken: readonly BrokenCitations[];
  /** What the project's declared probes answered when these verdicts were weighed. */
  readonly serving: ServingReading;
  /** The runtimes this issue's change runs in, each as read then (ISS-1368): what a hold names. */
  readonly owed: OwedRuntimes;
  /** Criteria earned on a runtime nothing could re-read: earned, and weaker than a checked one. */
  readonly uncorroborated: readonly number[];
}

/** Every name the tracker holds an attachment under for this issue, its comments' included. */
export async function heldAttachmentNames(issueId: string): Promise<Set<string>> {
  const own = await db
    .select({ name: issueAttachments.name })
    .from(issueAttachments)
    .where(eq(issueAttachments.issueId, issueId));
  const onComments = await db
    .select({ name: commentAttachments.name })
    .from(commentAttachments)
    .innerJoin(comments, eq(comments.id, commentAttachments.commentId))
    .where(eq(comments.issueId, issueId));
  return new Set([...own, ...onComments].map((row) => row.name));
}

const NEVER_JUDGED = 'no verdict was recorded for it';

/** Every reason this criterion is not shown earned, in the order they are read. */
function reasonsAgainst(
  pair: CriterionVerdict,
  weighed: WeighedVerdict,
  identities: IssueIdentities,
  unresolved: readonly CitationReport[],
): string[] {
  const out: string[] = [];
  if (!EARNED_VERDICTS.has(pair.verdict)) {
    out.push(`its verdict is \`${pair.verdict}\`, which is not earned`);
  } else if (!EARNED_STANDINGS.has(weighed.standing)) {
    const { standing, serving, runtime, beside } = weighed;
    const said = standingSentence(standing, pair.at, serving, identities, runtime);
    out.push(beside.length === 0 ? said : `${said} — ${beside.join('; ')}`);
  }
  if (unresolved.length > 0) out.push(citationSentence(unresolved));
  return out;
}

interface CriteriaFindings {
  readonly unearned: UnearnedCriterion[];
  readonly broken: BrokenCitations[];
  readonly uncorroborated: number[];
}

/**
 * The identity each verdict's sentence names: its own value, respelled by the longest spelling of
 * the same identity among this issue's verdicts of its kind that resolved alike, so one commit
 * written whole in one comment and abbreviated in another is one reason (ISS-1346, criterion 25).
 * Standing was decided on the verdict's own value before this, so only the words move, and a
 * verdict that resolved otherwise lends no spelling that would say something it did not.
 */
function spokenAt(
  judged: ReadonlyArray<{ pair: CriterionVerdict; standing: VerdictStanding }>,
): (pair: CriterionVerdict, standing: VerdictStanding) => VerdictIdentity | null {
  const pools = new Map<string, string[]>();
  const pool = (at: VerdictIdentity, standing: VerdictStanding) => `${at.kind}\u0000${standing}`;
  for (const { pair, standing } of judged) {
    if (!pair.at) continue;
    const key = pool(pair.at, standing);
    pools.set(key, [...(pools.get(key) ?? []), pair.at.value]);
  }
  return (pair, standing) => {
    if (!pair.at) return null;
    const spelled = longestSpelling(pools.get(pool(pair.at, standing)) ?? []);
    return { kind: pair.at.kind, value: spelled(pair.at.value) };
  };
}

interface Weighed {
  readonly serving: ServingReading;
  readonly owed: OwedRuntimes;
  readonly weighing: Weighing;
}

function findingsFor(
  numbers: readonly number[],
  latest: ReadonlyMap<number, CriterionVerdict>,
  weigh: Weighed,
  identities: IssueIdentities,
  held: ReadonlySet<string>,
): CriteriaFindings {
  const unearned: UnearnedCriterion[] = [];
  const broken: BrokenCitations[] = [];
  const uncorroborated: number[] = [];
  const weighed = new Map<number, WeighedVerdict>();
  for (const criterion of numbers) {
    const pair = latest.get(criterion);
    if (!pair) continue;
    weighed.set(
      criterion,
      weighVerdict(pair.at, weigh.serving, identities, weigh.owed, weigh.weighing),
    );
  }
  const spoken = spokenAt(
    [...weighed].map(([criterion, w]) => ({
      pair: latest.get(criterion) as CriterionVerdict,
      standing: w.standing,
    })),
  );
  for (const criterion of numbers) {
    const pair = latest.get(criterion);
    const w = weighed.get(criterion);
    if (!pair || !w) {
      unearned.push({ criterion, verdict: null, standing: null, why: NEVER_JUDGED });
      continue;
    }
    const { standing } = w;
    const unresolved = unresolvedCitations(pair.cited, held);
    if (unresolved.length > 0) broken.push({ criterion, unresolved });
    const said = { ...pair, at: spoken(pair, standing) };
    const reasons = reasonsAgainst(said, w, identities, unresolved);
    if (standing === 'uncorroborated' && reasons.length === 0) uncorroborated.push(criterion);
    if (reasons.length === 0) continue;
    unearned.push({ criterion, verdict: pair.verdict, standing, why: reasons.join('; and ') });
  }
  return { unearned, broken, uncorroborated };
}

/** The issue rows this check reads, and the only ones it reads. */
interface CriteriaRow {
  id: string;
  acceptanceCriteria: string | null;
  sessionContext: unknown;
  mergedCommitSha: string | null;
  mergedAt?: Date | null;
}

function byMerge(a: CriteriaRow, b: CriteriaRow): number {
  const at = (row: CriteriaRow) => row.mergedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const merged = at(a) - at(b);
  if (merged !== 0 && !Number.isNaN(merged)) return merged;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

async function reportFor(
  row: CriteriaRow,
  serving: ServingReading,
  weighing: Weighing,
): Promise<IssueCriteriaReport> {
  // No parseable criteria is a different, already-owned gap, not this check's to refuse.
  const identities = issueIdentities(row);
  const numbers = acceptanceCriteriaNumbers(row.acceptanceCriteria);
  const owed = owedRuntimes(row.id, weighing);
  if (numbers.length === 0) {
    return { issueId: row.id, unearned: [], broken: [], serving, owed, uncorroborated: [] };
  }
  const latest = await latestCriterionVerdicts(row.id);
  const held = await heldAttachmentNames(row.id);
  const found = findingsFor(numbers, latest, { serving, owed, weighing }, identities, held);
  return {
    issueId: row.id,
    unearned: found.unearned,
    broken: found.broken,
    serving,
    owed,
    uncorroborated: found.uncorroborated,
  };
}

/**
 * Every criterion these issues cannot be shown to have earned, and why each one is not earned.
 *
 * `serving` is ONE reading the caller took, shared by every issue here: one project, one answer
 * about it, one moment. It is required rather than defaulted, because a missing reading earns every
 * runtime verdict exactly as a project with no probe does, and the two must not look alike.
 *
 * `weighing` (ISS-1368) is read by the caller beside it. It may be left out, because without it a
 * verdict is weighed by equality alone against the deployment, which can hold one and never earn one.
 */
export async function unearnedCriteriaReports(
  issueIds: string[],
  serving: ServingReading,
  weighing: Weighing = UNWEIGHED,
): Promise<IssueCriteriaReport[]> {
  if (issueIds.length === 0) return [];
  const rows = (await db
    .select({
      id: issues.id,
      acceptanceCriteria: issues.acceptanceCriteria,
      sessionContext: issues.sessionContext,
      mergedCommitSha: issues.mergedCommitSha,
      mergedAt: issues.mergedAt,
    })
    .from(issues)
    .where(inArray(issues.id, issueIds))) as CriteriaRow[];
  // Oldest merge first, then id, as the sweep reads the gate: every list of them agrees (ISS-1346).
  const out: IssueCriteriaReport[] = [];
  for (const row of [...rows].sort(byMerge)) out.push(await reportFor(row, serving, weighing));
  return out;
}

/** Issues carrying a criterion that is not earned: never judged, `skipped`, `fail`, or stale. */
export async function issuesWithUnearnedCriteria(
  issueIds: string[],
  serving: ServingReading,
  weighing: Weighing = UNWEIGHED,
): Promise<string[]> {
  const reports = await unearnedCriteriaReports(issueIds, serving, weighing);
  return reports.filter((r) => r.unearned.length > 0).map((r) => r.issueId);
}
