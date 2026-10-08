import type { IssueKeyRefusalCode } from '@forge/contracts/issue-vocabulary';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import {
  canonicalIssueKey,
  formatIssueRef,
  ISS_SEQ_MAX,
  LEGACY_ISSUE_PREFIX,
} from '../lib/issue-ref.js';
import { activeIssuePrefix, heldIssuePrefixes, issuePrefixHolder } from './issue-prefix-read.js';

/** What a search term asks for: one issue by its key, or the issues whose text holds it. */
export type IssueSearchTerm = { kind: 'text'; text: string } | { kind: 'key'; issSeq: number };

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
 * Wider than `parseIssueRef`: any digit count, so an eleven-digit number is refused as a key rather
 * than searched; a space may stand for the hyphen; and the wrapping a pasted key carries — one pair
 * of `()`, `[]` or backticks, a leading `#`, trailing `, . ; : ! ?` — is not part of it. Double
 * quotes are not unwrapped: a quoted number is how a person searches it as text.
 */
const KEY_TERM =
  /^\s*[([`]?\s*#?\s*(?:([A-Za-z][A-Za-z0-9]{1,5})(?:\s*-\s*|\s+))?(\d+)\s*[)\]`]?\s*[,.;:!?]*\s*$/;

/**
 * Reads a search term as a key or as text. A bare number is a key; so is a number behind `ISS` or
 * behind a prefix some project has held. A prefix nobody ever held (`UTF-8`) leaves the term text.
 * A key this project cannot answer throws `IssueSearchKeyRefused` naming why.
 */
export async function readIssueSearchTerm(
  projectId: string,
  term: string,
): Promise<IssueSearchTerm> {
  const hit = KEY_TERM.exec(term);
  const digits = hit?.[2];
  if (!hit || !digits) return { kind: 'text', text: term };

  const given = hit[1]?.toUpperCase();
  const asRead = given ? `${given}-${digits}` : digits;
  if (given && given !== LEGACY_ISSUE_PREFIX) {
    const held = await heldIssuePrefixes(projectId);
    if (!held.includes(given)) {
      const holder = await issuePrefixHolder(given);
      if (!holder) return { kind: 'text', text: term };
      const answersTo = [LEGACY_ISSUE_PREFIX, ...held].map((p) => `\`${p}\``).join(', ');
      const whose =
        holder.projectId === null
          ? 'which belonged to a project that no longer exists'
          : 'which another project holds';
      throw new IssueSearchKeyRefused(
        'ISSUE_KEY_FOREIGN_PREFIX',
        400,
        `\`${asRead}\` names the prefix \`${given}\`, ${whose} — this project answers to ${answersTo}. The issues search looks in this project only.`,
      );
    }
  }

  const issSeq = digits.replace(/^0+/, '').length > 10 ? Number.POSITIVE_INFINITY : Number(digits);
  if (issSeq < 1 || issSeq > ISS_SEQ_MAX) {
    throw new IssueSearchKeyRefused(
      'ISSUE_KEY_OUT_OF_RANGE',
      400,
      `\`${asRead}\` reads as an issue key, and an issue's number runs from 1 to ${ISS_SEQ_MAX}.`,
    );
  }

  const [row] = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), eq(issues.issSeq, issSeq)))
    .limit(1);
  if (!row) {
    const key = formatIssueRef(await activeIssuePrefix(projectId), issSeq);
    const legacy = canonicalIssueKey(issSeq);
    const named = key === legacy ? key : `${key} (${legacy})`;
    throw new IssueSearchKeyRefused(
      'ISSUE_KEY_NOT_HELD',
      404,
      `\`${asRead}\` reads as an issue key, and this project holds no issue ${named}.`,
    );
  }
  return { kind: 'key', issSeq };
}
