/**
 * What's new, read by time: the entries of the running build's CHANGELOG.md, newest day first,
 * marked unread after the reader's seen mark. The version an entry shipped in is metadata, never the
 * grouping; a version's date is its day.
 */

import { WHATS_NEW_SEEN_KEY, type WhatsNewSeenValue } from '@forge/contracts/product-state';
import { PRODUCT_TOURS } from '@forge/contracts/tours';
import {
  isoWeekOf,
  newestVersionFirst,
  WHATS_NEW_AWAY_DAYS,
  WHATS_NEW_FIRST_LOOK_DAYS,
  WHATS_NEW_HIGHLIGHTS,
  WHATS_NEW_KIND_OF_SECTION,
  WHATS_NEW_KINDS,
  WHATS_NEW_MAX_WINDOW_DAYS,
  WHATS_NEW_WINDOW_DAYS,
  type WhatsNewAway,
  type WhatsNewCounts,
  type WhatsNewDay,
  type WhatsNewDigestView,
  type WhatsNewEntry,
  type WhatsNewFeed,
  type WhatsNewSummary,
  weekRange,
} from '@forge/contracts/whats-new';
import { readProductState } from '../preferences/index.js';
import { type ChangelogRelease, loadChangelog } from './changelog.js';

const DAY_MS = 86_400_000;

const KIND_ORDER = Object.fromEntries(WHATS_NEW_KINDS.map((k, i) => [k, i])) as Record<
  WhatsNewEntry['kind'],
  number
>;

/**
 * Newest day first, and within a day the newest version first; inside one version New comes before
 * improved and fixed, then the order the changelog lists them.
 */
function byPresentation(a: WhatsNewEntry, b: WhatsNewEntry): number {
  return (
    b.releasedAt.localeCompare(a.releasedAt) ||
    newestVersionFirst(a, b) ||
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
    a.key.localeCompare(b.key, 'en', { numeric: true })
  );
}

function tourRef(id: string | null): WhatsNewEntry['tour'] {
  if (id === null) return null;
  const tour = PRODUCT_TOURS.find((t) => t.id === id);
  if (!tour)
    throw new Error(`whats-new: tour ${id} passed the changelog parse but is not in the catalog`);
  return { id: tour.id, revision: tour.revision };
}

/** The entries of `releases` dated in [from, to), unread after `seenAt`. */
function releasedEntries(
  releases: readonly ChangelogRelease[],
  from: Date,
  to: Date,
  seenAt: Date | null,
): WhatsNewEntry[] {
  return releases.flatMap((r) => {
    const at = new Date(`${r.date}T00:00:00Z`);
    if (at < from || at >= to) return [];
    return r.entries.map(
      (e, i): WhatsNewEntry => ({
        key: `${r.version}#${i + 1}`,
        section: e.section,
        kind: WHATS_NEW_KIND_OF_SECTION[e.section],
        title: e.title,
        body: e.body,
        version: r.version,
        releasedAt: at.toISOString(),
        week: isoWeekOf(at),
        unread: seenAt === null || at > seenAt,
        tour: tourRef(e.tour),
      }),
    );
  });
}

function countsOf(entries: readonly WhatsNewEntry[]): WhatsNewCounts {
  return {
    new: entries.filter((e) => e.kind === 'new').length,
    improved: entries.filter((e) => e.kind === 'improved').length,
    fixed: entries.filter((e) => e.kind === 'fixed').length,
  };
}

/** A day of entries: the version's own calendar date, newest day first. */
function daysOf(entries: readonly WhatsNewEntry[]): WhatsNewDay[] {
  const byDate = new Map<string, WhatsNewEntry[]>();
  for (const e of entries) {
    const date = e.releasedAt.slice(0, 10);
    byDate.set(date, [...(byDate.get(date) ?? []), e]);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, list]) => ({ date, entries: [...list].sort(byPresentation) }));
}

/** The digests of `releases` for the weeks that overlap [from, to); the newest release's wins a week. */
function digestsOf(
  releases: readonly ChangelogRelease[],
  from: Date,
  to: Date,
): WhatsNewDigestView[] {
  const out = new Map<string, WhatsNewDigestView>();
  for (const r of releases) {
    for (const d of r.digests) {
      const range = weekRange(d.week);
      if (!range || range.to <= from || range.from >= to || out.has(d.week)) continue;
      out.set(d.week, {
        week: d.week,
        title: d.title,
        body: d.body,
        version: r.version,
        releasedAt: new Date(`${r.date}T00:00:00Z`).toISOString(),
      });
    }
  }
  return [...out.values()].sort((a, b) => b.week.localeCompare(a.week));
}

async function seenAtOf(userId: string): Promise<Date | null> {
  const state = await readProductState(userId, WHATS_NEW_SEEN_KEY);
  const value = state.value as WhatsNewSeenValue | null;
  return value ? new Date(value.at) : null;
}

/**
 * Where the feed starts: `since` when asked; a first look, with no seen mark, covers the last
 * `WHATS_NEW_FIRST_LOOK_DAYS`; else the window, reaching back to the mark when it is older. Never
 * before the bound.
 */
function feedStart(since: Date | undefined, seenAt: Date | null, now: Date): Date {
  const bound = new Date(now.getTime() - WHATS_NEW_MAX_WINDOW_DAYS * DAY_MS);
  const window = new Date(now.getTime() - WHATS_NEW_WINDOW_DAYS * DAY_MS);
  const firstLook = new Date(now.getTime() - WHATS_NEW_FIRST_LOOK_DAYS * DAY_MS);
  const start = since ?? (seenAt === null ? firstLook : seenAt < window ? seenAt : window);
  return start < bound ? bound : start;
}

function awayOf(
  entries: readonly WhatsNewEntry[],
  seenAt: Date | null,
  now: Date,
): WhatsNewAway | null {
  if (!seenAt) return null;
  const days = Math.floor((now.getTime() - seenAt.getTime()) / DAY_MS);
  if (days < WHATS_NEW_AWAY_DAYS) return null;
  const unread = entries.filter((e) => e.unread);
  return {
    since: seenAt.toISOString(),
    days,
    counts: countsOf(unread),
    highlights: [...unread]
      .sort(byPresentation)
      .slice(0, WHATS_NEW_HIGHLIGHTS)
      .map((e) => e.key),
  };
}

/** Whether one reader has anything unread, counted over the entries {@link readWhatsNew} would list. */
export async function readWhatsNewSummary(args: {
  userId: string;
  now: Date;
  releases?: readonly ChangelogRelease[];
}): Promise<WhatsNewSummary> {
  const releases = args.releases ?? loadChangelog();
  const seenAt = await seenAtOf(args.userId);
  const start = feedStart(undefined, seenAt, args.now);
  const end = new Date(args.now.getTime() + 1);
  const unread = releasedEntries(releases, start, end, seenAt).filter((e) => e.unread);
  return {
    version: releases[0]?.version ?? null,
    seenAt: seenAt?.toISOString() ?? null,
    unread: unread.length,
    counts: countsOf(unread),
  };
}

/** One reader's What's new on this build's changelog. */
export async function readWhatsNew(args: {
  userId: string;
  since: Date | undefined;
  timeZone: string;
  now: Date;
  releases?: readonly ChangelogRelease[];
}): Promise<WhatsNewFeed> {
  const { userId, timeZone, now } = args;
  const releases = args.releases ?? loadChangelog();
  const seenAt = await seenAtOf(userId);
  const start = feedStart(args.since, seenAt, now);
  const end = new Date(now.getTime() + 1);
  const entries = releasedEntries(releases, start, end, seenAt);
  const unread = entries.filter((e) => e.unread);
  return {
    version: releases[0]?.version ?? null,
    seenAt: seenAt?.toISOString() ?? null,
    since: start.toISOString(),
    timeZone,
    unread: unread.length,
    counts: countsOf(unread),
    away: awayOf(entries, seenAt, now),
    days: daysOf(entries),
    digests: digestsOf(releases, start, end),
  };
}
