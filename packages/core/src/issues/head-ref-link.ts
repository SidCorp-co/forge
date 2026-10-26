import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/client.js';
import { issues, projects } from '../db/schema.js';
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

/** A Forge issue page right before the key: `…/projects/<slug>/issues/ISS-11`. */
const ISSUE_URL_BEFORE = /\/projects\/([a-z0-9][a-z0-9-]*)\/issues\/$/i;

/**
 * A word right before the key that may name a project: `adminhub-api ISS-11`, `adminhub-api#ISS-11`,
 * `adminhub-api/ISS-11`, `adminhub-api: ISS-11`. A word inside a path (after a `/`) is a path's, not
 * a qualifier; whether the word IS a project is the database's to say.
 */
const WORD_BEFORE = /(?:^|[^A-Za-z0-9_/.-])([a-z0-9][a-z0-9-]*)(?:[ \t]+|[ \t]*[#/:][ \t]*)$/i;

/** How far back a qualifier is looked for: a URL to an issue page fits, a paragraph does not. */
const QUALIFIER_REACH = 300;

/** What names the project a description's key belongs to, where something does. */
type KeyQualifier = { kind: 'url' | 'word'; slug: string };

export interface DescriptionReference extends HeadRefReference {
  qualifier: KeyQualifier | null;
}

/** Every key a description names, each with the project word or issue URL written right before it. */
export function descriptionReferences(description: string): DescriptionReference[] {
  const out: DescriptionReference[] = [];
  for (const hit of description.matchAll(DESCRIPTION_KEY)) {
    const issSeq = Number(hit[2]);
    if (!hit[1] || !Number.isInteger(issSeq) || issSeq < 1 || issSeq > ISS_SEQ_MAX) continue;
    const before = description.slice(Math.max(0, hit.index - QUALIFIER_REACH), hit.index);
    const url = ISSUE_URL_BEFORE.exec(before)?.[1];
    const word = url ? undefined : WORD_BEFORE.exec(before)?.[1];
    const qualifier: KeyQualifier | null = url
      ? { kind: 'url', slug: url.toLowerCase() }
      : word
        ? { kind: 'word', slug: word.toLowerCase() }
        : null;
    out.push({ prefix: hit[1].toUpperCase(), issSeq, qualifier });
  }
  return out;
}

/**
 * Whether a qualified key names another project's issue. An issue URL names its project outright,
 * so one whose slug is not this project's is another's. A word only qualifies a key when it is a
 * project's slug — `fixes ISS-11` is prose — so it is another's when another project holds it.
 */
async function foreignQualifier(
  projectId: string,
  references: readonly DescriptionReference[],
  dbi: IssueRefReader,
): Promise<(q: KeyQualifier | null) => boolean> {
  const words = [
    ...new Set(references.flatMap((r) => (r.qualifier?.kind === 'word' ? [r.qualifier.slug] : []))),
  ];
  const urls = references.some((r) => r.qualifier?.kind === 'url');
  if (words.length === 0 && !urls) return () => false;
  const rows = await dbi
    .select({ id: projects.id, slug: projects.slug })
    .from(projects)
    .where(
      words.length === 0
        ? eq(projects.id, projectId)
        : or(eq(projects.id, projectId), inArray(sql`lower(${projects.slug})`, words)),
    );
  const own = rows.find((r) => r.id === projectId)?.slug.toLowerCase() ?? null;
  const others = new Set(rows.filter((r) => r.id !== projectId).map((r) => r.slug.toLowerCase()));
  return (q) => {
    if (!q) return false;
    return q.kind === 'url' ? q.slug !== own : others.has(q.slug);
  };
}

/**
 * Every issue of this project a change request delivers (REQ-63 BC-4): the key its branch leads
 * with, the numbers a `feat/…-iss-16-31` or `fix/…-iss-22` branch ends with, and every key its
 * description names. A key is read only under a prefix this project holds, so `REQ-4` or another
 * project's key links nothing; a number no issue carries links nothing either. A description key
 * another project qualifies — `adminhub-api ISS-11`, or a link to its issue page — is that
 * project's and links nothing here, though both projects number their issues `ISS-`. A branch link
 * wins over a description link for one issue.
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
  const described = descriptionReferences(args.description ?? '').filter((r) => held.has(r.prefix));
  const foreign = await foreignQualifier(args.projectId, described, dbi);
  for (const ref of described) {
    if (!foreign(ref.qualifier) && !wanted.has(ref.issSeq)) wanted.set(ref.issSeq, 'description');
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
