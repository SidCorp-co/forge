import { and, eq, inArray } from 'drizzle-orm';
import { db as defaultDb } from '../db/client.js';
import { issues } from '../db/schema.js';
import { ISS_SEQ_MAX, LEGACY_ISSUE_PREFIX } from '../lib/issue-ref.js';
import { heldIssuePrefixes, type IssueRefReader } from './issue-prefix-read.js';

/** A key opening a branch or one of its path segments: `iss-37-x`, `fix/iss-37-x`. */
const SEGMENT_LEAD_SHAPE = /^([A-Za-z][A-Za-z0-9]{1,5})-(\d{1,10})(?:[-_.]|$)/;

interface IssueReference {
  prefix: string;
  issSeq: number;
}

function inRange(issSeq: number): boolean {
  return Number.isInteger(issSeq) && issSeq >= 1 && issSeq <= ISS_SEQ_MAX;
}

/** `feat/…-iss-16-31` (REQ-63 BC-4): a delivery branch ending in a prefix and the numbers it delivers. */
const DELIVERY_BRANCH_SHAPE =
  /^(?:feat|fix)\/.+-([A-Za-z][A-Za-z0-9]{1,5})-(\d{1,10}(?:-\d{1,10})*)$/;

function numbersIn(raw: string): number[] {
  return raw.split('-').map(Number).filter(inRange);
}

/**
 * Every `(prefix, number)` the branch names, in the order it names them: the key opening each path
 * segment (`iss-37-x`, `fix/iss-37-x`), then the numbers a `feat/…-iss-16-31` branch ends with.
 * Whether a prefix is this project's is the caller's question.
 */
export function branchIssueReferences(headRef: string): IssueReference[] {
  const ref = headRef.trim();
  const out: IssueReference[] = [];
  for (const segment of ref.split('/')) {
    const hit = SEGMENT_LEAD_SHAPE.exec(segment);
    const issSeq = Number(hit?.[2]);
    if (hit?.[1] && inRange(issSeq)) out.push({ prefix: hit[1].toUpperCase(), issSeq });
  }
  const tail = DELIVERY_BRANCH_SHAPE.exec(ref);
  if (tail?.[1] && tail[2]) {
    const prefix = tail[1].toUpperCase();
    for (const issSeq of numbersIn(tail[2])) out.push({ prefix, issSeq });
  }
  return out;
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

export interface ChangeRequestIssueLink {
  issueId: string;
  linkedBy: 'head-ref' | 'description';
}

/**
 * Every issue of this project a change request delivers (REQ-63 BC-4), in the order it names them:
 * its branch's keys (`branchIssueReferences`), then the keys its description delivers
 * (`deliveredDescriptionReferences`). The first is its primary issue. A key is read only under a
 * prefix this project holds, so `REQ-4` or another project's key links nothing; a number no issue
 * carries links nothing either. A branch link wins over a description link for one issue.
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
  const take = (refs: IssueReference[], linkedBy: ChangeRequestIssueLink['linkedBy']) => {
    for (const ref of refs) {
      if (held.has(ref.prefix) && !wanted.has(ref.issSeq)) wanted.set(ref.issSeq, linkedBy);
    }
  };
  take(branchIssueReferences(args.headRef), 'head-ref');
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
  const [first] = await resolveIssuesForChangeRequest({ ...args, description: null }, dbi);
  return first?.issueId ?? null;
}
