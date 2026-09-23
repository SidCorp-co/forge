// ISS-1117 — no per-criterion verdict table exists; this reads the `forge-record: verdict`
// fence convention already used in issue comments (parseForgeRecord), the same shape ISS-1114
// and ISS-1139 carry live today.

import { eq, inArray } from 'drizzle-orm';
import { listIssueComments } from '../comments/service.js';
import { db } from '../db/client.js';
import { commentAttachments, comments, issueAttachments, issues } from '../db/schema.js';
import { parseForgeRecord } from '../messaging/forge-record.js';
import { criterionBlocksIn } from '../messaging/verdict-identity.js';
import { type CitationReport, citationSentence, unresolvedCitations } from './evidence-standing.js';
import {
  type IssueIdentities,
  issueIdentities,
  standingSentence,
  type VerdictIdentity,
  type VerdictStanding,
  verdictStanding,
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
  standing: VerdictStanding,
  identities: IssueIdentities,
  unresolved: readonly CitationReport[],
): string[] {
  const out: string[] = [];
  if (!EARNED_VERDICTS.has(pair.verdict)) {
    out.push(`its verdict is \`${pair.verdict}\`, which is not earned`);
  } else if (standing !== 'stands') {
    out.push(standingSentence(standing, pair.at, identities));
  }
  if (unresolved.length > 0) out.push(citationSentence(unresolved));
  return out;
}

interface CriteriaFindings {
  readonly unearned: UnearnedCriterion[];
  readonly broken: BrokenCitations[];
}

function findingsFor(
  numbers: readonly number[],
  latest: ReadonlyMap<number, CriterionVerdict>,
  identities: IssueIdentities,
  held: ReadonlySet<string>,
): CriteriaFindings {
  const unearned: UnearnedCriterion[] = [];
  const broken: BrokenCitations[] = [];
  for (const criterion of numbers) {
    const pair = latest.get(criterion);
    if (!pair) {
      unearned.push({ criterion, verdict: null, standing: null, why: NEVER_JUDGED });
      continue;
    }
    const unresolved = unresolvedCitations(pair.cited, held);
    if (unresolved.length > 0) broken.push({ criterion, unresolved });
    const standing = verdictStanding(pair.at, identities);
    const reasons = reasonsAgainst(pair, standing, identities, unresolved);
    if (reasons.length === 0) continue;
    unearned.push({ criterion, verdict: pair.verdict, standing, why: reasons.join('; and ') });
  }
  return { unearned, broken };
}

/** The issue rows this check reads, and the only ones it reads. */
interface CriteriaRow {
  id: string;
  acceptanceCriteria: string | null;
  sessionContext: unknown;
  mergedCommitSha: string | null;
}

async function reportFor(row: CriteriaRow): Promise<IssueCriteriaReport> {
  // No parseable criteria is a different, already-owned gap, not this check's to refuse.
  const numbers = acceptanceCriteriaNumbers(row.acceptanceCriteria);
  if (numbers.length === 0) return { issueId: row.id, unearned: [], broken: [] };
  const latest = await latestCriterionVerdicts(row.id);
  const held = await heldAttachmentNames(row.id);
  const found = findingsFor(numbers, latest, issueIdentities(row), held);
  return { issueId: row.id, unearned: found.unearned, broken: found.broken };
}

/** Every criterion these issues cannot be shown to have earned, and why each one is not earned. */
export async function unearnedCriteriaReports(issueIds: string[]): Promise<IssueCriteriaReport[]> {
  if (issueIds.length === 0) return [];
  const rows = (await db
    .select({
      id: issues.id,
      acceptanceCriteria: issues.acceptanceCriteria,
      sessionContext: issues.sessionContext,
      mergedCommitSha: issues.mergedCommitSha,
    })
    .from(issues)
    .where(inArray(issues.id, issueIds))) as CriteriaRow[];
  const out: IssueCriteriaReport[] = [];
  for (const row of rows) out.push(await reportFor(row));
  return out;
}

/** Issues carrying a criterion that is not earned: never judged, `skipped`, `fail`, or stale. */
export async function issuesWithUnearnedCriteria(issueIds: string[]): Promise<string[]> {
  const reports = await unearnedCriteriaReports(issueIds);
  return reports.filter((r) => r.unearned.length > 0).map((r) => r.issueId);
}
