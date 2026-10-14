import { eq, inArray } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { issues, projects } from '../db/schema.js';
import { logger } from '../logger.js';
import type { MessageRefusal } from '../messaging/contract.js';

/** The rule a refusal is filed under, so a caller reads which check refused rather than a prose guess. */
export const STORED_CREDENTIAL_RULE = 'stored-test-credential';

const GUIDE_SLUG = 'project-settings-and-test-credentials';
const READ_AT = '`forge_projects.get` → `environments.testCredentials`';

/**
 * A stored value of this many characters is secret wherever it appears in a text; a shorter one
 * (`admin`, `qa`) is matched only where the text is that value alone, because a short username
 * sits inside ordinary words and refusing every one of them would refuse prose, not a leak.
 */
const SECRET_LENGTH = 12;

export interface StoredCredential {
  /** The value itself. Never leaves this module in a marker, a log line or a refusal. */
  readonly value: string;
  /** The label of the row it came from, or its position where the label itself holds a stored value. */
  readonly id: string;
}

export interface CredentialHit {
  readonly id: string;
  /** 1-based, in the text as written; a value that is the whole text reports the first line and column. */
  readonly line: number;
  readonly column: number;
  /** The text around the hit with every stored value masked, so the quote cannot carry one. */
  readonly near: string;
}

/** Letters and digits only at the edges: `"qa-user".` is the value `qa-user` quoted. */
function bare(text: string): string {
  return text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/**
 * Lower-case without moving an offset: a code point whose lower-case form is a different length
 * (a capital I with a dot above becomes two) stays as written, so a span found in the folded text is a span of the original.
 */
const fold = (text: string): string =>
  text.replace(/[\s\S]/gu, (one) => {
    const lower = one.toLowerCase();
    return lower.length === one.length ? lower : one;
  });

function isWholeText(text: string, value: string): boolean {
  const held = fold(bare(value));
  return held.length > 0 && fold(bare(text)) === held;
}

/** The half-open spans of `text` a stored credential covers, overlaps merged, in order. */
function spansOf(text: string, credentials: readonly StoredCredential[]): Array<[number, number]> {
  const lowered = fold(text);
  const found: Array<[number, number]> = [];
  for (const { value } of credentials) {
    if (value.length >= SECRET_LENGTH) {
      const needle = fold(value);
      for (let at = lowered.indexOf(needle); at >= 0; at = lowered.indexOf(needle, at + 1)) {
        found.push([at, at + needle.length]);
      }
    } else if (isWholeText(text, value)) {
      found.push([0, text.length]);
    }
  }
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const span of found) {
    const last = merged.at(-1);
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return merged;
}

/** Each distinct credential that matches `text`, in the order the project stores them. */
function matching(text: string, credentials: readonly StoredCredential[]): StoredCredential[] {
  const lowered = fold(text);
  return credentials.filter((one) =>
    one.value.length >= SECRET_LENGTH
      ? lowered.includes(fold(one.value))
      : isWholeText(text, one.value),
  );
}

/**
 * What a row is called in a marker and a log line: its label, else its position, else nothing.
 * A name that holds a stored value is skipped, because a label equal to its password would be
 * written into the marker that exists to keep the password out.
 */
function identify(label: string, position: number, values: readonly string[]): string {
  const probe = values.map((value) => ({ value, id: '' }));
  const candidates = [label.trim(), `credential #${position + 1}`];
  return candidates.find((one) => one !== '' && spansOf(one, probe).length === 0) ?? '';
}

/**
 * Every string of a project's stored test credential rows except the label, read off the raw
 * column. `testCredentialSchema` is `catchall`, so a row may hold keys beyond the three named
 * ones and a normaliser that picked three would let those through.
 */
export function credentialsFrom(environments: unknown): StoredCredential[] {
  if (typeof environments !== 'object' || environments === null) return [];
  const rows = (environments as Record<string, unknown>).testCredentials;
  if (!Array.isArray(rows)) return [];
  const perRow = rows.map((row) => {
    if (typeof row !== 'object' || row === null) return { label: '', values: [] as string[] };
    const record = row as Record<string, unknown>;
    const values = Object.entries(record)
      .filter(([key, held]) => key !== 'label' && typeof held === 'string' && held !== '')
      .map(([, held]) => held as string);
    return { label: typeof record.label === 'string' ? record.label : '', values };
  });
  const everyValue = perRow.flatMap((row) => row.values);
  return perRow.flatMap((row, position) =>
    row.values.map((value) => ({ value, id: identify(row.label, position, everyValue) })),
  );
}

/** What a project stores as test credentials; empty for one that stores none. */
export async function loadStoredCredentials(
  projectId: string,
  executor: Tx = db,
): Promise<StoredCredential[]> {
  const [row] = await executor
    .select({ environments: projects.environments })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return credentialsFrom(row?.environments);
}

/** What each of the given issues' projects stores as test credentials, in one read. */
export async function loadCredentialsByIssue(
  issueIds: readonly string[],
  executor: Tx = db,
): Promise<Map<string, StoredCredential[]>> {
  if (issueIds.length === 0) return new Map();
  const rows = await executor
    .select({ issueId: issues.id, environments: projects.environments })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(inArray(issues.id, [...issueIds]));
  return new Map(rows.map((row) => [row.issueId, credentialsFrom(row.environments)]));
}

const MASK = '[withheld]';
const AROUND = 40;

function maskedAll(text: string, credentials: readonly StoredCredential[]): string {
  let out = '';
  let from = 0;
  for (const [start, end] of spansOf(text, credentials)) {
    out += `${text.slice(from, start)}${MASK}`;
    from = end;
  }
  return out + text.slice(from);
}

function positionOf(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  return { line, column: offset - (before.lastIndexOf('\n') + 1) + 1 };
}

/** The first stored credential in `text` and where it sits, or `null`; `near` is cut after masking every value. */
export function findCredential(
  text: string,
  credentials: readonly StoredCredential[],
): CredentialHit | null {
  const [first] = spansOf(text, credentials);
  if (!first) return null;
  const hit =
    matching(text.slice(first[0], first[1]), credentials)[0] ?? matching(text, credentials)[0];
  const masked = maskedAll(text, credentials).replace(/\s+/gu, ' ').trim();
  const at = Math.max(masked.indexOf(MASK), 0);
  const from = Math.max(at - AROUND, 0);
  const to = Math.min(at + MASK.length + AROUND, masked.length);
  const near = `${from > 0 ? '…' : ''}${masked.slice(from, to)}${to < masked.length ? '…' : ''}`;
  return { id: hit?.id ?? 'test credential', ...positionOf(text, first[0]), near };
}

/** The refusal a caller's write meets: what was found, where, and where the value is read instead. */
export function credentialRefusal(
  hit: CredentialHit,
  credentials: readonly StoredCredential[] = [],
  where: 'sent' | 'rendered' = 'sent',
): MessageRefusal {
  const place = where === 'sent' ? 'the body as sent' : 'the HTML as it is stored and read';
  const refusal = (locator: string): MessageRefusal => ({
    rule: STORED_CREDENTIAL_RULE,
    why:
      `this comment carries this project's test credential "${hit.id}", in ${place} at line ` +
      `${hit.line}, column ${hit.column}, where it reads "${hit.near}". A test credential is read ` +
      `at the authentication step and echoed nowhere after it (guide \`${GUIDE_SLUG}\`, rule 2), ` +
      `and there is no delete for what the tracker has taken. Take the value out and say where it ` +
      `is read instead: ${locator}`,
    quote: hit.near,
    shape: 'a comment says where a test credential is read, and never carries the credential',
    example: `log in with the test account read from ${locator}`,
  });
  const named = refusal(READ_AT);
  return spansOf(JSON.stringify(named), credentials).length === 0
    ? named
    : refusal("the project's stored test credentials");
}

/** What stands in the text where a value was: names the credential and where it is read. */
export function withheldMarker(id: string): string {
  return id === '' ? '[withheld]' : `[withheld: test credential "${id}", read at ${READ_AT}]`;
}

/** The text core writes, with its stored credentials replaced in place and everything else kept. */
export interface Withheld {
  readonly text: string;
  /** The identifier of each distinct credential replaced, never its value. */
  readonly ids: readonly string[];
}

export function withholdCredentials(
  text: string,
  credentials: readonly StoredCredential[],
): Withheld {
  const spans = spansOf(text, credentials);
  if (spans.length === 0) return { text, ids: [] };
  let out = '';
  let from = 0;
  const ids: string[] = [];
  for (const [start, end] of spans) {
    const covered = matching(text.slice(start, end), credentials);
    const named = covered.length > 0 ? covered : matching(text, credentials);
    const label = [...new Set(named.map((one) => one.id))].join('", "');
    for (const one of named) if (!ids.includes(one.id)) ids.push(one.id);
    const marker = withheldMarker(label);
    const safe = spansOf(marker, credentials).length === 0 ? marker : withheldMarker('');
    out += `${text.slice(from, start)}${safe}`;
    from = end;
  }
  return { text: out + text.slice(from), ids };
}

/** Says a withhold happened: the issue and the credentials' identifiers, never a value. */
export function reportWithheld(issueId: string, ids: readonly string[]): void {
  if (ids.length === 0) return;
  logger.warn(
    { issueId, credentials: ids.map((id) => id || 'a credential with no safe name') },
    'comment: a stored test credential was withheld from text core wrote onto an issue',
  );
}
