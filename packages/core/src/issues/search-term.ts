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

/** Wider than `parseIssueRef`'s ten digits, so an eleven-digit number is refused as a key rather than searched. */
const KEY_TERM = /^\s*(?:([A-Za-z][A-Za-z0-9]{1,5})-)?(\d+)\s*$/;

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
  if (given && given !== LEGACY_ISSUE_PREFIX) {
    const held = await heldIssuePrefixes(projectId);
    if (!held.includes(given)) {
      if (!(await issuePrefixHolder(given))) return { kind: 'text', text: term };
      const answersTo = [LEGACY_ISSUE_PREFIX, ...held].map((p) => `\`${p}\``).join(', ');
      throw new IssueSearchKeyRefused(
        'ISSUE_KEY_FOREIGN_PREFIX',
        400,
        `\`${term.trim()}\` names the prefix \`${given}\`, which another project holds — this project answers to ${answersTo}. The issues search looks in this project only.`,
      );
    }
  }

  const issSeq = digits.replace(/^0+/, '').length > 10 ? Number.POSITIVE_INFINITY : Number(digits);
  if (issSeq < 1 || issSeq > ISS_SEQ_MAX) {
    throw new IssueSearchKeyRefused(
      'ISSUE_KEY_OUT_OF_RANGE',
      400,
      `\`${term.trim()}\` reads as an issue key, and an issue's number runs from 1 to ${ISS_SEQ_MAX}.`,
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
      `\`${term.trim()}\` reads as an issue key, and this project holds no issue ${named}.`,
    );
  }
  return { kind: 'key', issSeq };
}
