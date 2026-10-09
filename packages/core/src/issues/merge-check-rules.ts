/**
 * The merge check's rules (Issue to release r20 `rule-merge`; REQ-36 BC-9, BC-15, BC-17; ISS-472),
 * pure: which report a merge may rely on, the record it is kept as, and whether a mark finds one at
 * the commit it marks. A fast-lane report (REQ-39 BC-7) needs only the fast checks here; whether the
 * change may take that lane is the fast lane's own rule (`fast-lane/rules.ts`), asked through a port.
 * `merge-check.ts` reads and writes around them.
 */

import type { CheckRun } from '@forge/contracts/check-runs';
import {
  MERGE_CHECK_KINDS,
  MERGE_CHECK_RECORD,
  type MergeCheckRefusalCode,
  type MergeCheckReport,
  REQUIRED_MERGE_CHECKS,
  type RequiredMergeCheck,
  requiredMergeChecksOf,
} from '@forge/contracts/merge-check';

/** Not run by the check yet: the issues that build each name it in every record. */
export const NOT_YET_CHECKED = 'kept probes (ISS-469), the review (ISS-473)';

export interface CheckRefusal {
  code: MergeCheckRefusalCode;
  path: string;
  detail: string;
}

function described(run: CheckRun): string {
  const files = run.files.length
    ? `: ${run.files.slice(0, 5).join(', ')}${run.files.length > 5 ? `, +${run.files.length - 5} more` : ''}`
    : '';
  return `\`${run.name}\` (${run.scope || 'workspace'})${files}`;
}

const isRequired = (name: string): name is RequiredMergeCheck =>
  (REQUIRED_MERGE_CHECKS as readonly string[]).includes(name);

/**
 * Why a report cannot let a merge through, or null: a check its lane needs that it never ran, a
 * required check filed under another kind (its time would be counted where it does not belong), a
 * base it is behind, then any check that ended red. The first fault answers, each naming its check.
 */
export function checkRefusal(report: MergeCheckReport): CheckRefusal | null {
  const needed = requiredMergeChecksOf(report.lane);
  const missing = needed.filter((n) => !report.checks.some((c) => c.name === n));
  if (missing.length) {
    const who = report.lane === 'fast' ? 'a fast-lane merge needs' : 'every merge needs';
    return {
      code: 'MERGE_CHECK_INCOMPLETE',
      path: '/checks',
      detail: `the report runs no ${missing.map((n) => `\`${n}\``).join(', ')} check, and ${who} ${needed.map((n) => `\`${n}\``).join(', ')}; a selection that held nothing to run reports its check with result \`none\`. Nothing was recorded`,
    };
  }
  const misfiled = report.checks.flatMap((c) =>
    isRequired(c.name) && MERGE_CHECK_KINDS[c.name] !== c.kind
      ? [`\`${c.name}\` is a ${MERGE_CHECK_KINDS[c.name]} check, not ${c.kind}`]
      : [],
  );
  if (misfiled.length) {
    return {
      code: 'MERGE_CHECK_KIND_MISMATCH',
      path: '/checks',
      detail: `${misfiled.join('; ')}: each check the merge needs is recorded under its own kind, so its time is counted there. Nothing was recorded`,
    };
  }
  const behind = report.checks.find((c) => c.name === 'rebased-on-base' && c.result === 'fail');
  if (behind) {
    return {
      code: 'MERGE_BEHIND_BASE',
      path: '/checks',
      detail: `${report.head.slice(0, 12)} does not contain the latest ${report.base.branch} (${report.base.sha.slice(0, 12)}), so its checks do not describe what would land. Rebase it onto ${report.base.branch} and run the merge check again. Nothing was recorded`,
    };
  }
  const red = report.checks.filter((c) => c.result === 'fail');
  if (red.length) {
    return {
      code: 'MERGE_CHECK_RED',
      path: '/checks',
      detail: `${red.map(described).join('; ')} ended red at ${report.head.slice(0, 12)}. Fix it and run the merge check again. Nothing was recorded`,
    };
  }
  return null;
}

/** At most this many characters in one record field. */
const FIELD_MAX = 400;

/** The checks a record names, by name and scope, cut to fit one field. */
function namedChecks(checks: readonly CheckRun[]): string {
  const head = `${checks.length} recorded with their kinds and durations (GET /api/issues/:id/checks): `;
  let out = head;
  for (const [i, c] of checks.entries()) {
    const part = `${i ? ', ' : ''}${c.name} (${c.scope || 'workspace'})`;
    const rest = checks.length - i;
    if (out.length + part.length > FIELD_MAX - 12) return `${out}, +${rest} more`;
    out += part;
  }
  return out;
}

/**
 * The fields a passing check is recorded as on its issue: what passed, where, and which checks it
 * ran. Each check's duration is its own row (`check-runs.ts`), never repeated here: one check is
 * one record (ISS-474).
 */
export function recordFields(report: MergeCheckReport): { key: string; value: string }[] {
  return [
    {
      key: 'lead',
      value: `Merge check passed at ${report.head.slice(0, 12)} on ${report.base.branch} ${report.base.sha.slice(0, 12)}: ${report.checks.length} checks`,
    },
    { key: 'check', value: MERGE_CHECK_RECORD },
    { key: 'result', value: 'pass' },
    { key: 'mode', value: report.mode },
    { key: 'lane', value: report.lane ?? 'full' },
    ...(report.patchId ? [{ key: 'patch-id', value: report.patchId }] : []),
    { key: 'base', value: `${report.base.branch}@${report.base.sha}` },
    { key: 'head', value: report.head },
    { key: 'touched', value: `${report.touched.length} file(s)` },
    { key: 'checks', value: namedChecks(report.checks) },
    { key: 'not-checked', value: NOT_YET_CHECKED },
  ];
}

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

/** Whether `commit` (7 to 64 hex, as a mark takes it) names one of `heads`. */
export function headMatches(heads: readonly string[], commit: string): boolean {
  const c = commit.toLowerCase();
  return heads.some((h) => h.startsWith(c));
}

/** What makes a mark owe a merge check: the project's declaration, or the issue's new pattern. */
export type CheckOwedBy = 'project' | 'pattern';

/** The mark's MERGE_CHECK_MISSING detail: what was owed, at which commit, and what stands. */
export function missingCheckDetail(args: {
  issueRef: string;
  owedBy: CheckOwedBy;
  commit: string | null;
  heads: readonly string[];
}): string {
  const why =
    args.owedBy === 'project'
      ? 'this project declares `validation.mergeCheck: required`'
      : `${args.issueRef} introduces an approved new pattern, whose catalog page only the merge check asks for`;
  const at = args.commit
    ? `no passing merge check is recorded at ${args.commit}`
    : 'the mark names no commit and the issue records none, so no merge check can be matched to it';
  const standing = args.heads.length
    ? ` (passing checks stand at ${args.heads.map((h) => h.slice(0, 12)).join(', ')})`
    : '';
  return `${why}, and ${at}${standing}. Run the project's merge check on the change rebased onto its base, record it with \`POST /api/issues/:id/merge-check\`, land that same commit and mark it. Nothing was marked`;
}
