import type { IssueKeyRefusalCode } from '@forge/contracts/issue-vocabulary';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import {
  canonicalIssueKey,
  formatIssueRef,
  ISS_SEQ_MAX,
  LEGACY_ISSUE_PREFIX,
} from '../lib/issue-ref.js';
import { activeIssuePrefix, heldIssuePrefixes, issuePrefixHolder } from './issue-prefix-read.js';

/** What a search term asks for: the issues its keys name, or the issues whose text holds it. */
export type IssueSearchTerm = { kind: 'text'; text: string } | { kind: 'key'; issSeqs: number[] };

/** A term read as a key that this project cannot answer with a row. Never answered with text. */
export class IssueSearchKeyRefused extends Error {
  constructor(
    readonly code: IssueKeyRefusalCode,
    readonly status: 400 | 404,
    message: string,
  ) {
    super(message);
    this.name = 'IssueSearchKeyRefused';
  }
}

/**
 * What a clipboard or an editor adds to a key without the person seeing it: zero-width and
 * bidirectional marks and the soft hyphen, which are dropped; the Unicode dashes, which stand for
 * the hyphen; and the fullwidth and small number signs, which stand for `#`. Applied to the reading
 * of a key and never to a term read as text, which is searched exactly as typed.
 */
const INVISIBLE = /[­​-‏‪-‮⁠﻿]/g;
const DASHES = /[‐-―−﹘﹣－]/g;
const NUMBER_SIGNS = /[＃﹟]/g;

const readable = (term: string) =>
  term.replace(INVISIBLE, '').replace(DASHES, '-').replace(NUMBER_SIGNS, '#').trim();

/**
 * One key as a person writes it, wider than `parseIssueRef`: any digit count, so an eleven-digit
 * number is refused as a key rather than searched; a space may stand for the hyphen; and the
 * wrapping a pasted key carries — one pair of `()`, `[]` or backticks, a leading `#`, trailing
 * `, . ; : ! ?` — is not part of it. Double quotes are not unwrapped: a quoted number is how a
 * person searches it as text.
 */
const KEY_UNIT =
  /[([`]?\s*(#)?\s*(?:([A-Za-z][A-Za-z0-9]{1,5})(?:\s*-\s*|\s+))?(\d+)\s*[)\]`]?[,.;:!?]*/y;
const UNIT_GAP = /[\s,;]*/y;

interface KeyUnit {
  /** The prefix as given, upper-cased, or undefined for `1280` and `#1280`. */
  prefix: string | undefined;
  /** What marks it as a key and not a number: a prefix or a `#`. */
  marked: boolean;
  digits: string;
}

/** The keys a term is made of, or null where any part of it is something else. */
function readKeyUnits(text: string): KeyUnit[] | null {
  const units: KeyUnit[] = [];
  let at = 0;
  for (;;) {
    UNIT_GAP.lastIndex = at;
    UNIT_GAP.exec(text);
    at = UNIT_GAP.lastIndex;
    if (at >= text.length) break;
    KEY_UNIT.lastIndex = at;
    const hit = KEY_UNIT.exec(text);
    const digits = hit?.[3];
    if (!hit || !digits) return null;
    const prefix = hit[2]?.toUpperCase();
    units.push({ prefix, marked: prefix !== undefined || hit[1] === '#', digits });
    at = KEY_UNIT.lastIndex;
  }
  return units.length > 0 ? units : null;
}

const asRead = (u: KeyUnit) => (u.prefix ? `${u.prefix}-${u.digits}` : u.digits);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIXED_KEY = /^[A-Za-z][A-Za-z0-9]{1,5}-\d+$/;

/**
 * An issue page's address, `…/issues/<id>`, read off the path with no check on the host: the answer
 * comes from whom the id belongs to. A last segment that is neither an id nor a prefixed key (a
 * GitHub issue number, say) is not one of ours, so the term stays text.
 */
async function readIssueLink(projectId: string, term: string): Promise<IssueSearchTerm | null> {
  let segments: string[];
  try {
    segments = new URL(term).pathname.split('/').filter(Boolean);
  } catch {
    return null;
  }
  const at = segments.lastIndexOf('issues');
  const raw = at === -1 ? undefined : segments[at + 1];
  if (!raw) return null;
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (PREFIXED_KEY.test(id)) {
    const key = await readIssueSearchTerm(projectId, id);
    return key.kind === 'key' ? key : null;
  }
  if (!UUID.test(id)) return null;

  const [row] = await db
    .select({ projectId: issues.projectId, issSeq: issues.issSeq })
    .from(issues)
    .where(eq(issues.id, id.toLowerCase()))
    .limit(1);
  if (!row) {
    throw new IssueSearchKeyRefused(
      'ISSUE_KEY_NOT_HELD',
      404,
      `\`${id}\` is the id of an issue page, and no issue has that id.`,
    );
  }
  if (row.projectId !== projectId) {
    const key = formatIssueRef(await activeIssuePrefix(row.projectId), row.issSeq);
    throw new IssueSearchKeyRefused(
      'ISSUE_KEY_FOREIGN_PREFIX',
      400,
      `That link opens \`${key}\`, which belongs to another project. The issues search looks in this project only.`,
    );
  }
  return { kind: 'key', issSeqs: [row.issSeq] };
}

/**
 * Reads a search term as keys, as a link to an issue page, or as text. A bare number is a key; so
 * is a number behind `ISS` or behind a prefix some project has held. Several keys are read as
 * several only where each one carries its prefix or a `#`, so `500 404` stays a search. A prefix
 * nobody ever held (`UTF-8`) leaves the term text. A key or a link this project cannot answer with
 * a row throws `IssueSearchKeyRefused` naming why, and the whole term is refused with it.
 */
export async function readIssueSearchTerm(
  projectId: string,
  term: string,
): Promise<IssueSearchTerm> {
  const text: IssueSearchTerm = { kind: 'text', text: term };
  const clean = readable(term);
  if (/^https?:\/\/\S+$/i.test(clean)) return (await readIssueLink(projectId, clean)) ?? text;

  const units = readKeyUnits(clean);
  if (!units || (units.length > 1 && units.some((u) => !u.marked))) return text;

  const held = units.some((u) => u.prefix && u.prefix !== LEGACY_ISSUE_PREFIX)
    ? await heldIssuePrefixes(projectId)
    : [];
  const holders = new Map<string, Awaited<ReturnType<typeof issuePrefixHolder>>>();
  for (const prefix of new Set(units.map((u) => u.prefix))) {
    if (prefix && prefix !== LEGACY_ISSUE_PREFIX && !held.includes(prefix)) {
      holders.set(prefix, await issuePrefixHolder(prefix));
    }
  }
  if ([...holders.values()].some((holder) => !holder)) return text;

  for (const u of units) {
    const holder = u.prefix ? holders.get(u.prefix) : undefined;
    if (u.prefix && holder) {
      const answersTo = [LEGACY_ISSUE_PREFIX, ...held].map((p) => `\`${p}\``).join(', ');
      const whose =
        holder.projectId === null
          ? 'which belonged to a project that no longer exists'
          : 'which another project holds';
      throw new IssueSearchKeyRefused(
        'ISSUE_KEY_FOREIGN_PREFIX',
        400,
        `\`${asRead(u)}\` names the prefix \`${u.prefix}\`, ${whose} — this project answers to ${answersTo}. The issues search looks in this project only.`,
      );
    }
    if (
      u.digits.replace(/^0+/, '').length > 10 ||
      Number(u.digits) < 1 ||
      Number(u.digits) > ISS_SEQ_MAX
    ) {
      throw new IssueSearchKeyRefused(
        'ISSUE_KEY_OUT_OF_RANGE',
        400,
        `\`${asRead(u)}\` reads as an issue key, and an issue's number runs from 1 to ${ISS_SEQ_MAX}.`,
      );
    }
  }

  const wanted = [...new Set(units.map((u) => Number(u.digits)))];
  const rows = await db
    .select({ issSeq: issues.issSeq })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), inArray(issues.issSeq, wanted)));
  const present = new Set(rows.map((r) => r.issSeq));
  const missing = units.find((u) => !present.has(Number(u.digits)));
  if (missing) {
    const seq = Number(missing.digits);
    const key = formatIssueRef(await activeIssuePrefix(projectId), seq);
    const legacy = canonicalIssueKey(seq);
    const named = key === legacy ? key : `${key} (${legacy})`;
    throw new IssueSearchKeyRefused(
      'ISSUE_KEY_NOT_HELD',
      404,
      `\`${asRead(missing)}\` reads as an issue key, and this project holds no issue ${named}.`,
    );
  }
  return { kind: 'key', issSeqs: wanted };
}
