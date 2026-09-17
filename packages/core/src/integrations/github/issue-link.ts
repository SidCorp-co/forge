/**
 * Which issue a pull request's head branch names, if any.
 *
 * A branch is the only thing a pull request and an issue reliably share: the
 * runner cuts `ISS-1062-github-integration` and pushes it, and that string is
 * what arrives in every `pull_request` payload. Nothing else in the payload is
 * the issue — a title is prose and a body is a description somebody edits.
 *
 * Resolution is deliberately narrow. A branch resolves to an issue only through
 * a prefix THIS project has held, and only to a row that belongs to it: a
 * prefix names the project an issue belongs to, so `FD-977` on a project that
 * never held `FD` is a different issue somewhere else and not this project's
 * 977 (ISS-992).
 */

import { and, eq } from 'drizzle-orm';
import { db as defaultDb } from '../../db/client.js';
import { issues } from '../../db/schema.js';
import { heldIssuePrefixes, type IssueRefReader } from '../../issues/issue-prefix-read.js';
import { ISS_SEQ_MAX, LEGACY_ISSUE_PREFIX } from '../../lib/issue-ref.js';

/**
 * The reference a branch name opens with, as `{ prefix, issSeq }`, or null.
 *
 * Anchored at the start and bounded by a separator, so `ISS-1062-github` and
 * `iss-1062` resolve and `feature/not-ISS-1062` does not. A branch that merely
 * mentions a key somewhere in the middle is naming something, and what it is
 * naming is not reliably the work.
 */
// cm:guard the separator class after the digits is what keeps `ISS-10` from matching the branch `ISS-1062-...`. Without it the regex is greedy-free and `\d+` would still take 1062, but a lazy edit to `\d{1,4}` would silently start linking one issue's branch to another's row.
const HEAD_REF_SHAPE = /^([A-Za-z][A-Za-z0-9]{1,5})-(\d{1,10})(?:[-_/.]|$)/;

export interface HeadRefReference {
  prefix: string;
  issSeq: number;
}

export function referenceInHeadRef(headRef: string): HeadRefReference | null {
  const hit = HEAD_REF_SHAPE.exec(headRef.trim());
  if (!hit?.[1] || !hit[2]) return null;
  const issSeq = Number(hit[2]);
  if (!Number.isInteger(issSeq) || issSeq < 1 || issSeq > ISS_SEQ_MAX) return null;
  return { prefix: hit[1].toUpperCase(), issSeq };
}

/**
 * The issue this branch names on this project, or null.
 *
 * Null is an ordinary answer and never an error: a pull request whose branch
 * names no issue — a dependabot bump, somebody's `try-something` — is still a
 * pull request this repository has, and the projection holds it either way.
 */
export async function resolveIssueForHeadRef(
  args: { projectId: string; headRef: string },
  dbi: IssueRefReader = defaultDb,
): Promise<string | null> {
  const ref = referenceInHeadRef(args.headRef);
  if (!ref) return null;

  // cm:guard the legacy prefix is admitted on every project and is not in `issue_prefix_aliases` — a NULL `projects.issue_prefix` means `ISS`, and the aliases table's own CHECK refuses that value, so reading only the aliases would stop resolving every branch on every project that never renamed.
  if (ref.prefix !== LEGACY_ISSUE_PREFIX) {
    const held = await heldIssuePrefixes(args.projectId, dbi);
    if (!held.some((p) => p.toUpperCase() === ref.prefix)) return null;
  }

  const [row] = await dbi
    .select({ id: issues.id })
    .from(issues)
    // cm:guard the project id is in the WHERE and not merely implied by the prefix check above. A prefix is unique across the deployment, so the two agree today; scoping the read anyway is what keeps a branch from resolving to another project's row if that ever stops being true.
    .where(and(eq(issues.projectId, args.projectId), eq(issues.issSeq, ref.issSeq)))
    .limit(1);
  return row?.id ?? null;
}
