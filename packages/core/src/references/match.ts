// Whether a followed source's release touches one of the project's open problems (ISS-1252): the
// open items nearest the release's lead text by meaning are shortlisted, and the fast model judges
// each pair, asked whether the release concretely changes or fixes what the item describes. Only a
// yes is a match, carrying the model's one-line why. Where no vector or no model can be had, the
// release is not judged and says why by name: it never falls back to matching words.

import { REFERENCE_FIRST_READ_DAYS } from '@forge/contracts/references';
import type { FollowedRelease } from '../integrations/github/index.js';

/** The most releases of one source digested in one read; older ones stay unread. */
const PER_READ = 10;

/** An open issue or requirement the release is read against. */
export interface OpenItem {
  kind: 'issue' | 'requirement';
  id: string;
  /** `ISS-n` or `REQ-n`. */
  ref: string;
  title: string;
  /** Its module labels or requirement area. */
  areas: readonly string[];
}

export interface ReleaseText {
  tag: string;
  name: string | null;
  body: string;
}

/** The notes a release is embedded by: its first lines say what it is; the rest is lists of commits. */
export const RELEASE_LEAD_CHARS = 1000;

/** The text a release is shortlisted by: its name and the first part of its notes. */
export const releaseLead = (release: ReleaseText): string =>
  `${release.name ?? release.tag}\n\n${release.body.trim().slice(0, RELEASE_LEAD_CHARS)}`;

/**
 * The cosine an open item must reach to the release's lead to be judged at all. It shortlists; it is
 * never the match, because no cosine separates a release that helps from one that does not: measured
 * on forge-dev (2026-11-17, the release lead against core's issue copies and the stored requirement
 * vectors), the 39 releases the word matcher filed wrongly (FB-651..686, FB-688..690) reached the
 * open items at up to 0.656 (openclaw 2026.11.5-beta.1 against ISS-1252), while the one real partial
 * match (coolify v4.7.0 against ISS-1082) sat at 0.652, and every release's 50th-nearest issue at
 * 0.58 to 0.65. Release-style paraphrases of open requirements led at 0.662 (REQ-43) to 0.794
 * (REQ-104). 0.6 keeps every real match measured, and leaves the judging to the model.
 */
export const SHORTLIST_FLOOR = 0.6;
/** The most open items judged for one release, nearest first. */
export const SHORTLIST_SIZE = 3;

/** An open item near a release, and how near. */
export interface NearItem {
  item: OpenItem;
  similarity: number;
}

/** The open items nearest a release's lead, nearest first; or why none could be read. */
export type NearestOpen = (
  projectId: string,
  lead: string,
  items: readonly OpenItem[],
) => Promise<{ ok: true; near: NearItem[] } | { ok: false; why: string }>;

/** The model's answer for one release and one open item; or why it gave none. */
export type JudgeRelease = (
  projectId: string,
  release: ReleaseText & { source: string },
  item: OpenItem,
) => Promise<{ ok: true; helps: boolean; why: string } | { ok: false; why: string }>;

export type ReleaseMatch =
  | { kind: 'helps'; item: OpenItem; why: string; similarity: number }
  | { kind: 'none' }
  | { kind: 'unjudged'; why: string };

/**
 * The open item `release` helps, as the model judged the shortlist nearest first; `none` where it
 * judged no pair a match, or nothing is near enough to judge; `unjudged`, naming why, where no vector
 * or no answer could be had.
 */
export async function matchRelease(
  projectId: string,
  release: ReleaseText & { source: string },
  items: readonly OpenItem[],
  ports: { nearest: NearestOpen; judge: JudgeRelease },
): Promise<ReleaseMatch> {
  if (items.length === 0) return { kind: 'none' };
  const near = await ports.nearest(projectId, releaseLead(release), items);
  if (!near.ok) return { kind: 'unjudged', why: near.why };
  const shortlist = near.near
    .filter((n) => n.similarity >= SHORTLIST_FLOOR)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, SHORTLIST_SIZE);
  for (const { item, similarity } of shortlist) {
    const verdict = await ports.judge(projectId, release, item);
    if (!verdict.ok) return { kind: 'unjudged', why: verdict.why };
    if (verdict.helps) return { kind: 'helps', item, why: verdict.why.trim(), similarity };
  }
  return { kind: 'none' };
}

/**
 * The releases of `read` not digested before, oldest first: those newer than the tag last seen, or,
 * on a source's first read, those published within REFERENCE_FIRST_READ_DAYS.
 */
export function freshReleases(
  releases: readonly FollowedRelease[],
  lastSeenTag: string | null,
  now: Date,
): FollowedRelease[] {
  const seenAt = lastSeenTag ? releases.findIndex((r) => r.tag === lastSeenTag) : -1;
  let fresh: FollowedRelease[];
  if (seenAt >= 0) fresh = releases.slice(0, seenAt);
  else if (lastSeenTag === null) {
    const since = now.getTime() - REFERENCE_FIRST_READ_DAYS * 86_400_000;
    fresh = releases.filter((r) => r.publishedAt && Date.parse(r.publishedAt) >= since);
  } else fresh = [...releases];
  return fresh.slice(0, PER_READ).reverse();
}
