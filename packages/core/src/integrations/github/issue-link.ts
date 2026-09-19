import { and, eq } from 'drizzle-orm';
import { db as defaultDb } from '../../db/client.js';
import { issues } from '../../db/schema.js';
import { heldIssuePrefixes, type IssueRefReader } from '../../issues/issue-prefix-read.js';
import { ISS_SEQ_MAX, LEGACY_ISSUE_PREFIX } from '../../lib/issue-ref.js';

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

  if (ref.prefix !== LEGACY_ISSUE_PREFIX) {
    const held = await heldIssuePrefixes(args.projectId, dbi);
    if (!held.some((p) => p.toUpperCase() === ref.prefix)) return null;
  }

  const [row] = await dbi
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.projectId, args.projectId), eq(issues.issSeq, ref.issSeq)))
    .limit(1);
  return row?.id ?? null;
}
