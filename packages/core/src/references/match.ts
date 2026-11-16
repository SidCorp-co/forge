// Whether a followed source's release touches one of the project's open problems (ISS-1252):
// deterministic word matching, explained by the words it matched. A release matches an open item when
// at least MIN_SHARED of the item's distinctive words appear in the release's tag, name or notes; a
// word most open items share is no evidence and is not counted. An area the source and the item both
// name adds weight, never a match on its own. No model reads the release, so a test needs no network.

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

export interface ReleaseMatch {
  item: OpenItem;
  terms: string[];
  score: number;
}

/** Distinctive words an item and a release must both hold. */
export const MIN_SHARED = 2;
/** A word in more than this share of the open items is too common to say which one a release helps. */
const COMMON_SHARE = 0.25;
/** The notes read: a release's first lines say what it is; the rest is lists of commits. */
const BODY_CHARS = 6000;

const STOP = new Set(
  (
    'about above after again also always among another because been before being below between both ' +
    'cannot could does doing down during each either every from further have having here into itself ' +
    'just less made make many more most much must need never none once only other over same should ' +
    'since some such than that their them then there these they this those through under until upon ' +
    'very were what when where whether which while whom whose will with within without would your ' +
    'added adds bump bumped change changed changes chore docs feat fixed fixes improve improved ' +
    'improvement minor patch release released releases update updated updates version versions ' +
    'issue issues pull merge merged thanks contributor contributors first full changelog note notes ' +
    'support supports work works working used uses using still now new'
  ).split(' '),
);

/** A word reduced to the form both sides share: a plural, tense or final `e` dropped. */
function stem(word: string): string {
  let w = word;
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (/(?:s|x|z|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  return w.length > 4 && w.endsWith('e') ? w.slice(0, -1) : w;
}

/** The distinctive words of a text, each in its shared form. */
export function wordsOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 4 || /^\d+$/.test(raw) || STOP.has(raw)) continue;
    out.add(stem(raw));
  }
  return out;
}

/**
 * The open item `release` most likely helps, with the words both hold, or null where none holds
 * MIN_SHARED distinctive words in common with it. Ties go to an issue before a requirement, then the
 * item listed first.
 */
export function matchRelease(
  release: ReleaseText,
  items: readonly OpenItem[],
  sourceAreas: readonly string[],
): ReleaseMatch | null {
  const said = wordsOf(`${release.tag} ${release.name ?? ''} ${release.body.slice(0, BODY_CHARS)}`);
  const itemWords = items.map((i) => wordsOf(`${i.title} ${i.areas.join(' ')}`));
  const seenIn = new Map<string, number>();
  for (const words of itemWords) for (const w of words) seenIn.set(w, (seenIn.get(w) ?? 0) + 1);
  const common = Math.max(2, Math.ceil(items.length * COMMON_SHARE));
  const areas = new Set(sourceAreas.map((a) => a.toLowerCase()));

  let best: ReleaseMatch | null = null;
  items.forEach((item, i) => {
    const words = itemWords[i] ?? new Set<string>();
    const terms = [...words].filter((w) => said.has(w) && (seenIn.get(w) ?? 0) <= common).sort();
    if (terms.length < MIN_SHARED) return;
    const sharesArea = item.areas.some((a) => areas.has(a.toLowerCase()));
    const score = terms.length + (sharesArea ? 1 : 0);
    const better =
      !best ||
      score > best.score ||
      (score === best.score && item.kind === 'issue' && best.item.kind !== 'issue');
    if (better) best = { item, terms, score };
  });
  return best;
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

