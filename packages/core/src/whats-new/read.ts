/**
 * What's new, read by time: the platform project's released issues, each its user-facing release
 * note, newest day first in the reader's time zone, marked unread after the reader's seen mark.
 * A `Skip` note, an issue with no user-facing note and a design-only landing (it ships nothing)
 * are never entries. The version an entry shipped in is metadata, never the grouping.
 */

import {
  designLandingRef,
  type LandingArtifact,
  type LandingSurface,
  SHIPS_NOTHING,
} from '@forge/contracts/landing-artifacts';
import { WHATS_NEW_SEEN_KEY, type WhatsNewSeenValue } from '@forge/contracts/product-state';
import type { ReleaseNotes } from '@forge/contracts/release-notes';
import { tourOfIssue } from '@forge/contracts/tours';
import {
  isoWeekOf,
  WHATS_NEW_AWAY_DAYS,
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
  type WhatsNewWeek,
  weekRange,
} from '@forge/contracts/whats-new';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, projects } from '../db/schema.js';
import { whatsNewDigests } from '../db/schema-whats-new.js';
import { activeIssuePrefix } from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { peopleOf } from '../lib/people.js';
import { releaseRunsByVersion } from '../pipeline/index.js';
import { readProductState } from '../preferences/index.js';
import { readContentLanguage } from '../project-config/index.js';

const DAY_MS = 86_400_000;

/** A placeholder a `Skip` note carries; a note of only this says nothing to a reader. */
const BLANK_NOTE = /^[\s\-–—.]*$/u;

/** Whether a landing deploys nothing: every artifact it names ships nothing, or it is a design approval. */
function designOnly(artifacts: LandingArtifact[] | null, landing: string | null): boolean {
  if (artifacts && artifacts.length > 0) {
    return artifacts.every((a) => SHIPS_NOTHING.includes(a.surface));
  }
  return designLandingRef(landing) !== null;
}

interface Shipped {
  version: string;
  releasedAt: Date;
}

/** Each issue's first shipped release on the project, from `from` up to `to`. */
async function shippedIssues(
  projectId: string,
  from: Date,
  to: Date,
): Promise<Map<string, Shipped>> {
  const runs = await releaseRunsByVersion(projectId);
  const out = new Map<string, Shipped>();
  for (const run of runs) {
    const at = run.releasedAt;
    if (!at || at < from || at >= to) continue;
    const ids = Array.isArray(run.metadata.issueIds) ? run.metadata.issueIds : [];
    for (const id of ids) {
      if (typeof id !== 'string') continue;
      const held = out.get(id);
      if (!held || at < held.releasedAt) out.set(id, { version: run.version, releasedAt: at });
    }
  }
  return out;
}

const KIND_ORDER = Object.fromEntries(WHATS_NEW_KINDS.map((k, i) => [k, i])) as Record<
  WhatsNewEntry['kind'],
  number
>;

/** New screens first, then new, improved, fixed; newest first within one rank. */
export function byPresentation(a: WhatsNewEntry, b: WhatsNewEntry): number {
  const rank = (e: WhatsNewEntry) => (e.kind === 'new' && e.ui ? -1 : KIND_ORDER[e.kind]);
  return (
    rank(a) - rank(b) || b.releasedAt.localeCompare(a.releasedAt) || a.key.localeCompare(b.key)
  );
}

/** The released entries of the project shipped in [from, to), unread after `seenAt`. */
export async function releasedEntries(
  projectId: string,
  from: Date,
  to: Date,
  seenAt: Date | null,
): Promise<WhatsNewEntry[]> {
  const shipped = await shippedIssues(projectId, from, to);
  if (shipped.size === 0) return [];
  const [rows, prefix] = await Promise.all([
    db
      .select({
        id: issues.id,
        seq: issues.issSeq,
        releaseNotes: issues.releaseNotes,
        mergedArtifacts: issues.mergedArtifacts,
        mergedLanding: issues.mergedLanding,
      })
      .from(issues)
      .where(and(eq(issues.projectId, projectId), inArray(issues.id, [...shipped.keys()]))),
    activeIssuePrefix(projectId),
  ]);
  return rows.flatMap((r): WhatsNewEntry[] => {
    const note = r.releaseNotes as ReleaseNotes | null;
    const at = shipped.get(r.id);
    if (!note || note.section === 'Skip' || BLANK_NOTE.test(note.userFacing) || !at) return [];
    if (designOnly(r.mergedArtifacts ?? null, r.mergedLanding)) return [];
    const surfaces = [
      ...new Set((r.mergedArtifacts ?? []).map((a) => a.surface)),
    ] as LandingSurface[];
    const key = r.seq != null ? formatIssueRef(prefix, r.seq) : r.id;
    return [
      {
        key,
        section: note.section,
        kind: WHATS_NEW_KIND_OF_SECTION[note.section],
        text: note.userFacing.trim(),
        surfaces,
        ui: surfaces.includes('ui'),
        version: at.version,
        releasedAt: at.releasedAt.toISOString(),
        week: isoWeekOf(at.releasedAt),
        unread: seenAt === null || at.releasedAt > seenAt,
        tour: tourOfIssue(key),
      },
    ];
  });
}

function countsOf(entries: readonly WhatsNewEntry[]): WhatsNewCounts {
  return {
    new: entries.filter((e) => e.kind === 'new').length,
    screens: entries.filter((e) => e.kind === 'new' && e.ui).length,
    improved: entries.filter((e) => e.kind === 'improved').length,
    fixed: entries.filter((e) => e.kind === 'fixed').length,
  };
}

/** The calendar date a moment falls on in `timeZone`, as `YYYY-MM-DD`. */
export function localDate(at: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(at));
}

function daysOf(entries: readonly WhatsNewEntry[], timeZone: string): WhatsNewDay[] {
  const byDate = new Map<string, WhatsNewEntry[]>();
  for (const e of entries) {
    const date = localDate(e.releasedAt, timeZone);
    byDate.set(date, [...(byDate.get(date) ?? []), e]);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, list]) => ({ date, entries: [...list].sort(byPresentation) }));
}

async function digestsOf(
  projectId: string,
  weeks: readonly string[],
): Promise<WhatsNewDigestView[]> {
  if (weeks.length === 0) return [];
  const rows = await db
    .select()
    .from(whatsNewDigests)
    .where(
      and(eq(whatsNewDigests.projectId, projectId), inArray(whatsNewDigests.week, [...weeks])),
    );
  const people = await peopleOf(rows.map((r) => r.writtenBy));
  return rows
    .map((r) => ({
      week: r.week,
      title: r.title,
      body: r.body,
      entryKeys: r.entryKeys,
      author: { name: people.get(r.writtenBy)?.name ?? null, agency: r.writtenAgency },
      writtenAt: r.writtenAt.toISOString(),
    }))
    .sort((a, b) => b.week.localeCompare(a.week));
}

/** The digest written for one week, or null. */
export async function digestOf(
  projectId: string,
  week: string,
): Promise<WhatsNewDigestView | null> {
  return (await digestsOf(projectId, [week]))[0] ?? null;
}

async function seenAtOf(userId: string): Promise<Date | null> {
  const state = await readProductState(userId, WHATS_NEW_SEEN_KEY);
  const value = state.value as WhatsNewSeenValue | null;
  return value ? new Date(value.at) : null;
}

/** Where the feed starts: `since` when asked, else the window, reaching back to the mark when it is older; never before the bound. */
function feedStart(since: Date | undefined, seenAt: Date | null, now: Date): Date {
  const bound = new Date(now.getTime() - WHATS_NEW_MAX_WINDOW_DAYS * DAY_MS);
  const window = new Date(now.getTime() - WHATS_NEW_WINDOW_DAYS * DAY_MS);
  const start = since ?? (seenAt && seenAt < window ? seenAt : window);
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

async function projectSlugOf(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.slug ?? null;
}

/** One reader's What's new on the platform project. */
export async function readWhatsNew(args: {
  projectId: string;
  userId: string;
  since: Date | undefined;
  timeZone: string;
  now: Date;
}): Promise<WhatsNewFeed> {
  const { projectId, userId, timeZone, now } = args;
  const seenAt = await seenAtOf(userId);
  const start = feedStart(args.since, seenAt, now);
  const [entries, language, slug] = await Promise.all([
    releasedEntries(projectId, start, new Date(now.getTime() + 1), seenAt),
    readContentLanguage(projectId),
    projectSlugOf(projectId),
  ]);
  const weeks = [...new Set(entries.map((e) => e.week))];
  const unread = entries.filter((e) => e.unread);
  return {
    projectId,
    projectSlug: slug,
    contentLanguage: language.contentLanguage,
    seenAt: seenAt?.toISOString() ?? null,
    since: start.toISOString(),
    timeZone,
    unread: unread.length,
    counts: countsOf(unread),
    away: awayOf(entries, seenAt, now),
    days: daysOf(entries, timeZone),
    digests: await digestsOf(projectId, weeks),
  };
}

/** One week's entries and its digest, as the agent that writes the digest reads them. */
export async function readWhatsNewWeek(projectId: string, week: string): Promise<WhatsNewWeek> {
  const range = weekRange(week);
  if (!range) throw new Error(`whats-new: ${week} reached the week read without resolving`);
  const [entries, language, digest] = await Promise.all([
    releasedEntries(projectId, range.from, range.to, null),
    readContentLanguage(projectId),
    digestOf(projectId, week),
  ]);
  return {
    projectId,
    contentLanguage: language.contentLanguage,
    week,
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    entries: entries.map((e) => ({ ...e, unread: false })).sort(byPresentation),
    digest,
  };
}
