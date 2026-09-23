// ISS-1117 — no per-criterion verdict table exists; this reads the `forge-record: verdict`
// fence convention already used in issue comments (parseForgeRecord), the same shape ISS-1114
// and ISS-1139 carry live today.

import { inArray } from 'drizzle-orm';
import { listIssueComments } from '../comments/service.js';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { parseForgeRecord } from '../messaging/forge-record.js';
import { criterionBlocksIn } from '../messaging/verdict-identity.js';
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
    out.push({ criterion: block.criterion, verdict: block.verdict, at });
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

export interface IssueCriteriaReport {
  readonly issueId: string;
  readonly unearned: readonly UnearnedCriterion[];
}

const NEVER_JUDGED = 'no verdict was recorded for it';

function unearnedFor(
  numbers: readonly number[],
  latest: ReadonlyMap<number, CriterionVerdict>,
  identities: IssueIdentities,
): UnearnedCriterion[] {
  const out: UnearnedCriterion[] = [];
  for (const criterion of numbers) {
    const pair = latest.get(criterion);
    if (!pair) {
      out.push({ criterion, verdict: null, standing: null, why: NEVER_JUDGED });
      continue;
    }
    const standing = verdictStanding(pair.at, identities);
    const earned = EARNED_VERDICTS.has(pair.verdict);
    if (standing === 'stands' && earned) continue;
    const why = earned
      ? standingSentence(standing, pair.at, identities)
      : `its verdict is \`${pair.verdict}\`, which is not earned`;
    out.push({ criterion, verdict: pair.verdict, standing, why });
  }
  return out;
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
  if (numbers.length === 0) return { issueId: row.id, unearned: [] };
  const latest = await latestCriterionVerdicts(row.id);
  return { issueId: row.id, unearned: unearnedFor(numbers, latest, issueIdentities(row)) };
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
