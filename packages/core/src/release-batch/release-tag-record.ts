/**
 * What a release run keeps of its tag (REQ-63 BC-13..15), read without touching the database: the
 * commit the tag is owed on (`metadata.tagOwed`, written once by `release-tag.ts:oweReleaseTag`) and
 * the host's answer (`metadata.tag`). The release page and the version rule both read it here.
 */

import type { ReleaseTag, ReleaseVersionCarrier } from '@forge/contracts/releases';

/** Where the commit a tag is owed on became known. */
export const TAG_OWED_FROM = [
  /** A promotion release: its promotion request seen merged, through Forge or on the host. */
  'promotion',
  /** A recorded release or landing: the commit its record names, in the cut's own unit. */
  'record',
  /** A release run: the head it reported for its range, the commit it cut. */
  'range',
  /** A release that merges change requests: its last merge. */
  'merge',
  /** A release run that reported no cut: the commit its finish names. */
  'finish',
] as const;
export type TagOwedFrom = (typeof TAG_OWED_FROM)[number];

export interface TagOwed {
  name: string;
  commit: string | null;
  from: TagOwedFrom;
  at: string;
}

const WHOLE = /^[0-9a-f]{40}$/i;

export const wholeCommit = (v: unknown): string | null =>
  typeof v === 'string' && WHOLE.test(v) ? v.toLowerCase() : null;

/** The commit a run's tag is owed on, or null where none was ever owed. */
export function tagOwedOf(metadata: unknown): TagOwed | null {
  const raw = (metadata as { tagOwed?: unknown } | null)?.tagOwed;
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Partial<TagOwed>;
  if (
    typeof o.name !== 'string' ||
    typeof o.at !== 'string' ||
    !(TAG_OWED_FROM as readonly unknown[]).includes(o.from)
  ) {
    return null;
  }
  return { name: o.name, commit: wholeCommit(o.commit), from: o.from as TagOwedFrom, at: o.at };
}

/** The host's answer a run carries, or null where it carries none it can read. */
function answerOf(metadata: unknown): ReleaseTag | null {
  const raw = (metadata as { tag?: unknown } | null)?.tag;
  if (typeof raw !== 'object' || raw === null) return null;
  const t = raw as Partial<ReleaseTag>;
  if (
    (t.state !== 'tagged' && t.state !== 'refused' && t.state !== 'untagged') ||
    typeof t.name !== 'string' ||
    typeof t.at !== 'string'
  ) {
    return null;
  }
  return {
    state: t.state,
    name: t.name,
    commit: wholeCommit(t.commit),
    created: t.created === true,
    on: wholeCommit(t.on),
    code: t.code ?? null,
    reason: typeof t.reason === 'string' ? t.reason : null,
    at: t.at,
  };
}

/** The run's tag: the host's answer, else `owed` while the host has not answered yet, else null. */
export function releaseTagOf(metadata: unknown): ReleaseTag | null {
  const answer = answerOf(metadata);
  if (answer) return answer;
  const owed = tagOwedOf(metadata);
  if (!owed) return null;
  return {
    state: 'owed',
    name: owed.name,
    commit: owed.commit,
    created: false,
    on: null,
    code: null,
    reason: null,
    at: owed.at,
  };
}

/**
 * The tag Forge put, or is putting, for this run's version, as what carries that version outside
 * Forge: a release that ended unshipped keeps its tag (BC-14), so its next attempt cannot wear the
 * version again. A tag refused or never asked for carries nothing of this run.
 */
export function forgeTagCarrier(metadata: unknown): ReleaseVersionCarrier | null {
  const tag = releaseTagOf(metadata);
  if (!tag || (tag.state !== 'tagged' && tag.state !== 'owed')) return null;
  if (tag.state === 'owed' && tag.commit === null) return null;
  return { kind: 'tag', name: tag.name };
}
