import { and, eq, inArray } from 'drizzle-orm';
import { db as defaultDb } from '../db/client.js';
import { issues } from '../db/schema.js';
import type { ChangeRequestLinkKind, ChangeRequestReading } from '../db/schema-repo-projection.js';
import { ISS_SEQ_MAX, LEGACY_ISSUE_PREFIX } from '../lib/issue-ref.js';
import { heldIssuePrefixes, type IssueRefReader } from './issue-prefix-read.js';

/** A key opening a branch or one of its path segments: `iss-37-x`, `fix/iss-37-x`. */
const SEGMENT_LEAD_SHAPE = /^([A-Za-z][A-Za-z0-9]{1,5})-(\d{1,10})(?:[-_.]|$)/;

interface IssueReference {
  prefix: string;
  issSeq: number;
}

/** A key a branch names, and where: a path segment's opening key, or the `feat/…-iss-16` tail. */
interface BranchReference extends IssueReference {
  from: 'lead' | 'tail';
}

function inRange(issSeq: number): boolean {
  return Number.isInteger(issSeq) && issSeq >= 1 && issSeq <= ISS_SEQ_MAX;
}

/**
 * `feat/…-iss-16` (REQ-63 BC-4 r11): a delivery branch ending in the one key it carries. A digit
 * suffix after the key — a run's attempt number, `fix/x-iss-50-2` — is no second key (ISS-1027).
 */
const DELIVERY_BRANCH_SHAPE =
  /^(?:feat|fix)\/.+-([A-Za-z][A-Za-z0-9]{1,5})-(\d{1,10})(?:-\d{1,10})*$/;

/**
 * Every `(prefix, number)` the branch names, in the order it names them: the key opening each path
 * segment (`iss-37-x`, `fix/iss-37-x`), then the key a `feat/…-iss-16` branch ends with, a digit
 * suffix after it read as no key.
 * Whether a prefix is this project's is the caller's question.
 */
export function branchIssueReferences(headRef: string): BranchReference[] {
  const ref = headRef.trim();
  const out: BranchReference[] = [];
  for (const segment of ref.split('/')) {
    const hit = SEGMENT_LEAD_SHAPE.exec(segment);
    const issSeq = Number(hit?.[2]);
    if (hit?.[1] && inRange(issSeq)) {
      out.push({ prefix: hit[1].toUpperCase(), issSeq, from: 'lead' });
    }
  }
  const tail = DELIVERY_BRANCH_SHAPE.exec(ref);
  const tailSeq = Number(tail?.[2]);
  if (tail?.[1] && inRange(tailSeq)) {
    out.push({ prefix: tail[1].toUpperCase(), issSeq: tailSeq, from: 'tail' });
  }
  return out;
}

/**
 * Which reading of a change request named an issue it links (ISS-1027): `branch-lead` where a path
 * segment of the branch opens with its key, `branch-tail` where only the key a `feat|fix/…-iss-n`
 * branch ends with holds it, `title` and `body` as the link was written, so a caller sees which part
 * of a request named each issue before its merge stamps it. A head-ref link whose number a lead key
 * holds reads as the lead, as the link took it first.
 */
export function readingOfLink(
  headRef: string,
  issSeq: number,
  linkedBy: ChangeRequestLinkKind,
): ChangeRequestReading {
  if (linkedBy === 'title') return 'title';
  if (linkedBy === 'description') return 'body';
  const refs = branchIssueReferences(headRef).filter((r) => r.issSeq === issSeq);
  return refs.length > 0 && refs.every((r) => r.from === 'tail') ? 'branch-tail' : 'branch-lead';
}

/** Each stored link of a change request with the reading that named it (`readingOfLink`), in order. */
export async function changeRequestLinkReadings(
  args: {
    headRef: string;
    links: ReadonlyArray<{ issueId: string; linkedBy: ChangeRequestLinkKind }>;
  },
  dbi: IssueRefReader = defaultDb,
): Promise<
  Array<{ issueId: string; linkedBy: ChangeRequestLinkKind; namedBy: ChangeRequestReading }>
> {
  if (args.links.length === 0) return [];
  const rows = await dbi
    .select({ id: issues.id, issSeq: issues.issSeq })
    .from(issues)
    .where(
      inArray(
        issues.id,
        args.links.map((l) => l.issueId),
      ),
    );
  const seqOf = new Map(rows.map((r) => [r.id, r.issSeq]));
  return args.links.map((l) => ({
    ...l,
    namedBy: readingOfLink(args.headRef, seqOf.get(l.issueId) ?? Number.NaN, l.linkedBy),
  }));
}

/** One issue key: a prefix, a hyphen, a number, and no letter, digit or hyphen running on. */
const KEY = '([A-Za-z][A-Za-z0-9]{1,5})-(\\d{1,10})(?![A-Za-z0-9-])';
/** What may stand between two keys of one list: a comma, an ampersand, `and`, or a space. */
const BETWEEN_KEYS = '\\s*(?:,|&|\\band\\b)?\\s*';
/** The closing verbs the source hosts read (`Closes #12`), with `deliver` and `implement`. */
const CLOSING_VERB =
  '\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|deliver(?:s|ed)?|implement(?:s|ed)?)\\b\\s*:?\\s*';

const LIST_OF_KEYS = new RegExp(`^${KEY}(?:${BETWEEN_KEYS}${KEY})*\\s*[.;]?$`, 'i');
const KEY_GLOBAL = new RegExp(KEY, 'gi');
const VERB_THEN_KEYS = new RegExp(`${CLOSING_VERB}(${KEY}(?:${BETWEEN_KEYS}${KEY})*)`, 'gi');
/** A quote mark, a list bullet or number, a task box, at the start of a line. */
const LINE_LEAD = /^\s*(?:>\s*)*(?:(?:[-*+]|\d{1,3}[.)])\s+)?(?:\[[ xX]\]\s+)?/;
/** Markdown emphasis and code marks, which never change what a line says. */
const EMPHASIS = /[*_`]/g;

function keysIn(text: string): IssueReference[] {
  const out: IssueReference[] = [];
  for (const hit of text.matchAll(KEY_GLOBAL)) {
    const issSeq = Number(hit[2]);
    if (hit[1] && inRange(issSeq)) out.push({ prefix: hit[1].toUpperCase(), issSeq });
  }
  return out;
}

/**
 * The keys a description delivers, in the order it gives them (ISS-705). A key is delivered where
 * it stands alone on its line, bulleted or not, with only other keys beside it (`- ISS-37, ISS-40`),
 * or right after a closing verb with only separators between (`Closes ISS-37`, `Also delivers
 * ISS-3.`). A key anywhere else is prose — named, not delivered — and so is a key another project's
 * slug qualifies (`adminhub-api ISS-11`), which sits in neither form.
 */
export function deliveredDescriptionReferences(description: string): IssueReference[] {
  const out: IssueReference[] = [];
  for (const raw of description.split(/\r?\n/)) {
    const line = raw.replace(EMPHASIS, '').replace(LINE_LEAD, '').trim();
    if (!line) continue;
    if (LIST_OF_KEYS.test(line)) {
      out.push(...keysIn(line));
      continue;
    }
    for (const hit of line.matchAll(VERB_THEN_KEYS)) out.push(...keysIn(hit[1] ?? ''));
  }
  return out;
}

/** Where a title's key stands to be delivered: the title's start or a clause's (`;`, `,`, `|`, `(`, `[`). */
const TITLE_LEAD_KEYS = new RegExp(`(?:^|[;,|([])\\s*(${KEY}(?:${BETWEEN_KEYS}${KEY})*)`, 'gi');

/**
 * The keys a title delivers, in the order it gives them (ISS-855): a key leading the title or one of
 * its clauses, with any keys listed after it (`ISS-31: …; ISS-24: …`, `[ISS-12] …`, `ISS-1, ISS-2
 * and ISS-3 — …`), or right after a closing verb (`… (fixes ISS-9)`). A key inside a sentence is
 * prose, and one another project's slug qualifies (`adminhub-api ISS-11`) sits in neither form
 * (FB-295).
 */
export function titleIssueReferences(title: string): IssueReference[] {
  const line = title.replace(EMPHASIS, '').trim();
  const hits: Array<{ at: number; refs: IssueReference[] }> = [];
  for (const hit of line.matchAll(TITLE_LEAD_KEYS)) {
    hits.push({ at: hit.index ?? 0, refs: keysIn(hit[1] ?? '') });
  }
  for (const hit of line.matchAll(VERB_THEN_KEYS)) {
    hits.push({ at: hit.index ?? 0, refs: keysIn(hit[1] ?? '') });
  }
  return hits.sort((a, b) => a.at - b.at).flatMap((h) => h.refs);
}

const KEY_SHAPES =
  'a branch `fix/iss-n-…` or `feat/…-iss-n`, a title leading with `ISS-n: …`, or a description line holding only `ISS-n` or `Closes ISS-n`';

/**
 * Why a change request links no issue, named by what was read (ISS-855): its branch, its title, the
 * keys its description delivers, and the shapes that would have linked. A key read under a prefix
 * this project does not hold, or with a number no issue carries, is named with it.
 */
export function noIssueReason(args: {
  headRef: string;
  title: string | null;
  description: string | null;
  prefixes: readonly string[];
}): string {
  const read = [
    ...branchIssueReferences(args.headRef),
    ...titleIssueReferences(args.title ?? ''),
    ...deliveredDescriptionReferences(args.description ?? ''),
  ].map((r) => `${r.prefix}-${r.issSeq}`);
  const named = [...new Set(read)];
  const keys =
    named.length === 0
      ? 'no issue key in a delivery form'
      : `${named.join(', ')}, none an issue of this project (its prefixes: ${args.prefixes.join(', ')})`;
  return (
    `linked to no issue: branch \`${args.headRef}\`, title ${JSON.stringify(args.title ?? '')}, and ` +
    `${args.description?.trim() ? 'its description' : 'no description'} carry ${keys}. ` +
    `A key links from ${KEY_SHAPES}; edit the title or description and refresh it.`
  );
}

export interface ChangeRequestIssueLink {
  issueId: string;
  linkedBy: 'head-ref' | 'title' | 'description';
}

/** The issue prefixes a project's keys are read under: its own, and the legacy `ISS`. */
export async function changeRequestPrefixes(
  projectId: string,
  dbi: IssueRefReader = defaultDb,
): Promise<string[]> {
  const held = [LEGACY_ISSUE_PREFIX, ...(await heldIssuePrefixes(projectId, dbi))];
  return [...new Set(held.map((p) => p.toUpperCase()))];
}

/**
 * Every issue of this project a change request delivers (REQ-63 BC-4), in the order it names them:
 * its branch's keys (`branchIssueReferences`), then the keys its title delivers
 * (`titleIssueReferences`), then the ones its description delivers
 * (`deliveredDescriptionReferences`). The first is its primary issue. A key is read only under a
 * prefix this project holds, so `REQ-4` or another project's key links nothing; a number no issue
 * carries links nothing either. The first place to name an issue is the one its link records.
 */
export async function resolveIssuesForChangeRequest(
  args: {
    projectId: string;
    headRef: string;
    title?: string | null;
    description?: string | null;
  },
  dbi: IssueRefReader = defaultDb,
): Promise<ChangeRequestIssueLink[]> {
  const held = new Set(await changeRequestPrefixes(args.projectId, dbi));
  const wanted = new Map<number, ChangeRequestIssueLink['linkedBy']>();
  const take = (refs: IssueReference[], linkedBy: ChangeRequestIssueLink['linkedBy']) => {
    for (const ref of refs) {
      if (held.has(ref.prefix) && !wanted.has(ref.issSeq)) wanted.set(ref.issSeq, linkedBy);
    }
  };
  take(branchIssueReferences(args.headRef), 'head-ref');
  take(titleIssueReferences(args.title ?? ''), 'title');
  take(deliveredDescriptionReferences(args.description ?? ''), 'description');
  if (wanted.size === 0) return [];
  const rows = await dbi
    .select({ id: issues.id, issSeq: issues.issSeq })
    .from(issues)
    .where(and(eq(issues.projectId, args.projectId), inArray(issues.issSeq, [...wanted.keys()])));
  const idOf = new Map(rows.map((r) => [r.issSeq, r.id]));
  return [...wanted].flatMap(([issSeq, linkedBy]) => {
    const issueId = idOf.get(issSeq);
    return issueId ? [{ issueId, linkedBy }] : [];
  });
}

/**
 * Why a change request this project projects links no issue (ISS-855): an issue it names that a
 * person unlinked stays off it (ISS-705), and is said so; otherwise `noIssueReason`.
 */
export async function explainNoIssue(
  args: { projectId: string; headRef: string; title: string | null; description: string | null },
  dbi: IssueRefReader = defaultDb,
): Promise<string> {
  const named = await resolveIssuesForChangeRequest(args, dbi);
  if (named.length > 0) {
    return `linked to no issue: the ${named.length} issue(s) it names were each unlinked from it by a person, and stay off it until relinked`;
  }
  return noIssueReason({ ...args, prefixes: await changeRequestPrefixes(args.projectId, dbi) });
}

/**
 * The issue this branch names on this project, or null: the first one its keys resolve to, read
 * by the same grammar a change request's links are (`resolveIssuesForChangeRequest`).
 *
 * Null is an ordinary answer and never an error: a pull request whose branch
 * names no issue — a dependabot bump, somebody's `try-something` — is still a
 * pull request this repository has, and the projection holds it either way.
 */
export async function resolveIssueForHeadRef(
  args: { projectId: string; headRef: string },
  dbi: IssueRefReader = defaultDb,
): Promise<string | null> {
  const [first] = await resolveIssuesForChangeRequest(
    { ...args, title: null, description: null },
    dbi,
  );
  return first?.issueId ?? null;
}
