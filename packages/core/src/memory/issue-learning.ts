/**
 * Where a caller's write under a mirror source lands. A mirror (`issue`, `comment`, `job`) is core's
 * copy of another record, kept under that record's id, so an upsert there would replace the copy in
 * silence and be replaced by the next index. Runs reach for `{ source: 'issue', sourceRef: <issue> }`
 * to keep a learning about the issue they work (ISS-457 round 1, ISS-470): that call is taken for
 * what it means, a learning about that issue, and lands as its own note, linked to it. Every other
 * mirror write is refused by name, naming the write that keeps both.
 */

import { fingerprint } from '@forge/contracts/fingerprint';
import { MEMORY_MIRROR_SOURCES, type MemoryRefusalCode } from '@forge/contracts/memory';
import { formatIssueRef } from '../lib/issue-ref.js';
import { refuser } from '../lib/refusal.js';
import { memoryIssueReads } from './ports.js';

const refuse = refuser<MemoryRefusalCode>('MEMORY_REFUSED');

/** The fields of a write this decides on. */
export interface MirrorWrite {
  projectId: string;
  source: string;
  sourceRef: string;
  textContent: string;
  metadata?: Record<string, unknown> | undefined;
}

/** Where a learning about an issue landed instead of the issue's own row: reported, never silent. */
export interface LandedAs {
  source: 'note';
  sourceRef: string;
  /** The issue it is about, by key. */
  about: string;
  reason: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^([A-Z][A-Z0-9]{0,15})-([1-9]\d{0,8})$/i;

/** The issue of this project a ref names, by its id or its key; null where it names none. */
async function issueNamed(
  projectId: string,
  ref: string,
): Promise<{ key: string; id: string | null } | null> {
  const reads = memoryIssueReads();
  if (UUID.test(ref)) {
    const issue = await reads.releasedIssue(projectId, ref);
    return issue ? { key: formatIssueRef(issue.issuePrefix, issue.issSeq), id: ref } : null;
  }
  const m = KEY.exec(ref);
  if (!m) return null;
  const prefix = (m[1] as string).toUpperCase();
  const seq = Number(m[2]);
  const { active, held } = await reads.issuePrefixes(projectId);
  const known = new Set([active ?? 'ISS', ...held].map((p) => p.toUpperCase()));
  if (!known.has(prefix)) return null;
  const standing = (await reads.issueStandings(projectId, [seq])).get(seq);
  return standing && !standing.archived ? { key: `${prefix}-${seq}`, id: null } : null;
}

const keepBoth = (source: string) =>
  `${source} memory is core's copy of each ${source}, kept from the ${source} itself, so this write would replace it. Keep both: write the learning with source note, naming the issue it is about.`;

/** The text names the issue, so the issue's Memory tab and its cites find the note. */
const naming = (text: string, key: string) =>
  new RegExp(`(^|[^A-Za-z0-9-])${key}(?![0-9])`, 'i').test(text) ? text : `${text} (${key})`;

/**
 * The write as it lands: unchanged for a source a caller owns; a learning about an issue as its own
 * note, linked to it by its text and `metadata.issueId`, under a ref of the issue and the text, so a
 * resend is the same row and a second learning is another; refused by name for any other mirror.
 */
export async function landingOfMirrorWrite<W extends MirrorWrite>(
  input: W,
): Promise<{ input: W; landedAs: LandedAs | null }> {
  if (!(MEMORY_MIRROR_SOURCES as readonly string[]).includes(input.source)) {
    return { input, landedAs: null };
  }
  const issue =
    input.source === 'issue' ? await issueNamed(input.projectId, input.sourceRef) : null;
  if (!issue) {
    throw refuse(
      'MEMORY_MIRROR_READ_ONLY',
      input.source === 'issue'
        ? `${keepBoth('issue')} ${input.sourceRef.slice(0, 80)} names no live issue of this project.`
        : keepBoth(input.source),
      input.source === 'issue' ? '/sourceRef' : '/source',
    );
  }
  const textContent = naming(input.textContent, issue.key);
  const sourceRef = `learning/${issue.key}/${fingerprint(textContent)}`;
  return {
    input: {
      ...input,
      source: 'note',
      sourceRef,
      textContent,
      metadata: {
        ...(input.metadata ?? {}),
        about: issue.key,
        ...(issue.id ? { issueId: issue.id } : {}),
      },
    },
    landedAs: {
      source: 'note',
      sourceRef,
      about: issue.key,
      reason: `A learning about ${issue.key} is kept as its own note, linked to it; the issue's own entry is unchanged.`,
    },
  };
}
