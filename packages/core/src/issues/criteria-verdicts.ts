// ISS-1117 — no per-criterion verdict table exists; this reads the `forge-record: verdict`
// fence convention already used in issue comments (parseForgeRecord), the same shape ISS-1114
// and ISS-1139 carry live today.

import { inArray } from 'drizzle-orm';
import { listIssueComments } from '../comments/service.js';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { parseForgeRecord } from '../messaging/forge-record.js';

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
}

/** The (criterion, verdict) pairs one `verdict`-kind `forge-record` fence names. */
export function verdictPairsIn(body: string): CriterionVerdict[] {
  const record = parseForgeRecord(body);
  if (record?.kind !== 'verdict') return [];

  const out: CriterionVerdict[] = [];
  let pendingCriterion: number | null = null;
  for (const field of record.fields) {
    if (field.key === 'criterion') {
      const n = Number.parseInt(field.value, 10);
      pendingCriterion = Number.isFinite(n) ? n : null;
      continue;
    }
    if (field.key === 'verdict' && pendingCriterion !== null) {
      out.push({ criterion: pendingCriterion, verdict: field.value.trim() });
      pendingCriterion = null;
    }
  }
  return out;
}

// Read oldest-to-newest so a re-judged criterion overwrites the verdict before it.
export async function latestCriterionVerdicts(issueId: string): Promise<Map<number, string>> {
  const rows = await listIssueComments(issueId);
  const latest = new Map<number, string>();
  for (const row of rows) {
    for (const pair of verdictPairsIn(row.body)) {
      latest.set(pair.criterion, pair.verdict);
    }
  }
  return latest;
}

// No parseable criteria is a different, already-owned gap, not this check's to refuse.
async function issueCriteriaEarned(
  issueId: string,
  acceptanceCriteria: string | null,
): Promise<boolean> {
  const numbers = acceptanceCriteriaNumbers(acceptanceCriteria);
  if (numbers.length === 0) return true;
  const latest = await latestCriterionVerdicts(issueId);
  return numbers.every((n) => EARNED_VERDICTS.has(latest.get(n) ?? ''));
}

/** Issues carrying a criterion that is not earned: never judged, `skipped`, or `fail`. */
export async function issuesWithUnearnedCriteria(issueIds: string[]): Promise<string[]> {
  if (issueIds.length === 0) return [];
  const rows = await db
    .select({ id: issues.id, acceptanceCriteria: issues.acceptanceCriteria })
    .from(issues)
    .where(inArray(issues.id, issueIds));
  const out: string[] = [];
  for (const row of rows) {
    if (!(await issueCriteriaEarned(row.id, row.acceptanceCriteria))) out.push(row.id);
  }
  return out;
}
