import { and, eq, inArray } from 'drizzle-orm';
import { db as defaultDb } from '../db/client.js';
import { issues } from '../db/schema.js';
import { ISS_SEQ_MAX, LEGACY_ISSUE_PREFIX } from '../lib/issue-ref.js';
import { heldIssuePrefixes, type IssueRefReader } from './issue-prefix-read.js';

const HEAD_REF_SHAPE = /^([A-Za-z][A-Za-z0-9]{1,5})-(\d{1,10})(?:[-_/.]|$)/;

interface HeadRefReference {
  prefix: string;
  issSeq: number;
}

function referenceInHeadRef(headRef: string): HeadRefReference | null {
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

/** `feat/…-iss-16-31` (REQ-63 BC-4): a delivery branch ending in a prefix and the numbers it delivers. */
const DELIVERY_BRANCH_SHAPE =
  /^(?:feat|fix)\/.+-([A-Za-z][A-Za-z0-9]{1,5})-(\d{1,10}(?:-\d{1,10})*)$/;

/** An issue key anywhere in a description: a prefix the project holds, a hyphen, a number. */
const DESCRIPTION_KEY = /\b([A-Za-z][A-Za-z0-9]{1,5})-(\d{1,10})\b/g;

export interface ChangeRequestIssueLink {
  issueId: string;
  linkedBy: 'head-ref' | 'description';
}

function numbersIn(raw: string): number[] {
  return raw
    .split('-')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= ISS_SEQ_MAX);
}

/** Every `(prefix, number)` the branch names: its leading key, and a delivery branch's tail. */
function headRefReferences(headRef: string): HeadRefReference[] {
  const out: HeadRefReference[] = [];
  const lead = referenceInHeadRef(headRef);
  if (lead) out.push(lead);
  const tail = DELIVERY_BRANCH_SHAPE.exec(headRef.trim());
  if (tail?.[1] && tail[2]) {
    const prefix = tail[1].toUpperCase();
    for (const issSeq of numbersIn(tail[2])) out.push({ prefix, issSeq });
  }
  return out;
}

function descriptionReferences(description: string): HeadRefReference[] {
  const out: HeadRefReference[] = [];
  for (const hit of description.matchAll(DESCRIPTION_KEY)) {
    const issSeq = Number(hit[2]);
    if (hit[1] && Number.isInteger(issSeq) && issSeq >= 1 && issSeq <= ISS_SEQ_MAX) {
      out.push({ prefix: hit[1].toUpperCase(), issSeq });
    }
  }
  return out;
}

/**
 * Every issue of this project a change request delivers (REQ-63 BC-4): the key its branch leads
 * with, the numbers a `feat/…-iss-16-31` or `fix/…-iss-22` branch ends with, and every key its
 * description names. A key is read only under a prefix this project holds, so `REQ-4` or another
 * project's key links nothing; a number no issue carries links nothing either. A branch link wins
 * over a description link for one issue.
 */
export async function resolveIssuesForChangeRequest(
  args: { projectId: string; headRef: string; description?: string | null },
  dbi: IssueRefReader = defaultDb,
): Promise<ChangeRequestIssueLink[]> {
  const held = new Set(
    [LEGACY_ISSUE_PREFIX, ...(await heldIssuePrefixes(args.projectId, dbi))].map((p) =>
      p.toUpperCase(),
    ),
  );
  const wanted = new Map<number, ChangeRequestIssueLink['linkedBy']>();
  for (const ref of headRefReferences(args.headRef)) {
    if (held.has(ref.prefix)) wanted.set(ref.issSeq, 'head-ref');
  }
  for (const ref of descriptionReferences(args.description ?? '')) {
    if (held.has(ref.prefix) && !wanted.has(ref.issSeq)) wanted.set(ref.issSeq, 'description');
  }
  if (wanted.size === 0) return [];
  const rows = await dbi
    .select({ id: issues.id, issSeq: issues.issSeq })
    .from(issues)
    .where(and(eq(issues.projectId, args.projectId), inArray(issues.issSeq, [...wanted.keys()])));
  return rows
    .filter((r) => r.issSeq !== null && wanted.has(r.issSeq))
    .sort((a, b) => (a.issSeq ?? 0) - (b.issSeq ?? 0))
    .map((r) => ({
      issueId: r.id,
      linkedBy: wanted.get(r.issSeq as number) as ChangeRequestIssueLink['linkedBy'],
    }));
}
