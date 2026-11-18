/**
 * Whether a mark finds a passing merge check covering its commit (REQ-79 BC-5), pure: the heads and
 * ranges the passing checks among an issue's core-written records cover, and the MERGE_CHECK_MISSING
 * detail when none covers it. The record a passing check is kept as is `merge-check-rules.ts:recordFields`.
 */

import { MERGE_CHECK_RECORD } from '@forge/contracts/merge-check';

/** The heads of the passing merge checks among an issue's core-written records. */
export function passingHeads(
  records: readonly { fields: readonly { key: string; value: string }[] }[],
): string[] {
  return records.flatMap((r) => {
    const field = (key: string) => r.fields.find((f) => f.key === key)?.value;
    if (field('check') !== MERGE_CHECK_RECORD || field('result') !== 'pass') return [];
    const head = field('head');
    return head ? [head.toLowerCase()] : [];
  });
}

/** A passing merge check's range: its base, its head, and the commits it covered (head included). */
export interface PassingRange {
  base: string;
  head: string;
  commits: string[];
}

/** The ranges of the passing merge checks among an issue's core-written records. */
export function passingRanges(
  records: readonly { fields: readonly { key: string; value: string }[] }[],
): PassingRange[] {
  return records.flatMap((r) => {
    const field = (key: string) => r.fields.find((f) => f.key === key)?.value;
    if (field('check') !== MERGE_CHECK_RECORD || field('result') !== 'pass') return [];
    const head = field('head')?.toLowerCase();
    if (!head) return [];
    const base = (field('base') ?? '').split('@').at(-1)?.toLowerCase() ?? '';
    const commits = (field('commits') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    return [{ base, head, commits: commits.includes(head) ? commits : [...commits, head] }];
  });
}

/**
 * Whether a passing check covers `commit` (7 to 64 hex): its head, or a commit its range
 * base..head held (REQ-79 BC-5). An issue landed mid-batch is marked on the batch's later passing
 * check, whose range holds it; a check whose range does not hold it covers nothing.
 */
export function rangeCovers(ranges: readonly PassingRange[], commit: string): boolean {
  const c = commit.toLowerCase();
  return ranges.some((r) => r.commits.some((k) => k.startsWith(c)));
}

/** What makes a mark owe a merge check: the project's declaration, or the issue's new pattern. */
export type CheckOwedBy = 'project' | 'pattern' | 'cleanup';

/** The mark's MERGE_CHECK_MISSING detail: what was owed, at which commit, and what stands. */
export function missingCheckDetail(args: {
  issueRef: string;
  owedBy: CheckOwedBy;
  commit: string | null;
  ranges: readonly PassingRange[];
}): string {
  const why = {
    project: 'this project declares `validation.mergeCheck: required`',
    pattern: `${args.issueRef} introduces an approved new pattern, whose catalog page the merge check asks for`,
    cleanup: `${args.issueRef} is rated high impact on a project that deploys on land, so its mark owes a passing merge check whose range holds its commit (REQ-79 BC-5); no cleanup report is asked`,
  }[args.owedBy];
  const at = args.commit
    ? `no passing merge check covers ${args.commit}`
    : 'the mark names no commit and the issue records none, so no merge check can be matched to it';
  const standing = args.ranges.length
    ? ` (passing checks cover ${args.ranges
        .map(
          (r) => `${r.base.slice(0, 12)}..${r.head.slice(0, 12)} (${r.commits.length} commit(s))`,
        )
        .join(', ')}, none holding it)`
    : '';
  return `${why}, and ${at}${standing}. Run the project's merge check on the change rebased onto its base, record it with \`POST /api/issues/:id/merge-check\`, land that same commit and mark it. Nothing was marked`;
}
