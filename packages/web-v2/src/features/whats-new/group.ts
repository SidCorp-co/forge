import { isoWeekOf, weekRange } from "@forge/contracts/whats-new";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import type { WhatsNewDigestView, WhatsNewEntry, WhatsNewFeed, WhatsNewKind } from "./types";

const DAY_MS = 86_400_000;

/** A heading of the panel: its words, the week's digest when it opens a week, and its entries. */
export interface WhatsNewSection {
  key: string;
  label: { key: ProductCopyKey; date?: Date };
  digest: WhatsNewDigestView | null;
  entries: WhatsNewEntry[];
}

/** The calendar date a moment falls on in `timeZone`, as `YYYY-MM-DD`. */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

const RANK: Record<WhatsNewKind, number> = { new: 0, improved: 1, fixed: 2 };

/** New first, then improved, fixed; newest first within one rank. */
export function byPresentation(a: WhatsNewEntry, b: WhatsNewEntry): number {
  return RANK[a.kind] - RANK[b.kind] || b.releasedAt.localeCompare(a.releasedAt);
}

/**
 * The panel's headings, newest first: this week's digest under "This week", then Today, Yesterday
 * and the rest of the week, then one heading per earlier week with its digest on top. `kind`
 * narrows the entries; a heading left with neither entries nor a digest is dropped.
 */
export function sectionsOf(feed: WhatsNewFeed, now: Date, kind: WhatsNewKind | null = null): WhatsNewSection[] {
  const tz = feed.timeZone;
  const today = localDate(now, tz);
  const yesterday = localDate(new Date(now.getTime() - DAY_MS), tz);
  const thisWeek = isoWeekOf(now);
  const digests = new Map(feed.digests.map((d) => [d.week, d]));
  const keep = (e: WhatsNewEntry) => kind === null || e.kind === kind;

  const todays: WhatsNewEntry[] = [];
  const yesterdays: WhatsNewEntry[] = [];
  const restOfWeek: WhatsNewEntry[] = [];
  const earlier = new Map<string, WhatsNewEntry[]>();
  for (const day of feed.days) {
    for (const e of day.entries.filter(keep)) {
      if (day.date === today) todays.push(e);
      else if (day.date === yesterday) yesterdays.push(e);
      else if (e.week === thisWeek) restOfWeek.push(e);
      else earlier.set(e.week, [...(earlier.get(e.week) ?? []), e]);
    }
  }
  for (const week of digests.keys()) if (week !== thisWeek && !earlier.has(week)) earlier.set(week, []);

  const sections: WhatsNewSection[] = [];
  const current = digests.get(thisWeek) ?? null;
  if (current) sections.push({ key: "this-week", label: { key: "whatsNew.group.thisWeek" }, digest: current, entries: [] });
  sections.push({ key: "today", label: { key: "whatsNew.group.today" }, digest: null, entries: todays.sort(byPresentation) });
  sections.push({ key: "yesterday", label: { key: "whatsNew.group.yesterday" }, digest: null, entries: yesterdays.sort(byPresentation) });
  sections.push({
    key: "rest-of-week",
    label: { key: current ? "whatsNew.group.earlierThisWeek" : "whatsNew.group.thisWeek" },
    digest: null,
    entries: restOfWeek.sort(byPresentation),
  });
  for (const week of [...earlier.keys()].sort().reverse()) {
    sections.push({
      key: week,
      label: { key: "whatsNew.group.week", date: weekRange(week)?.from },
      digest: digests.get(week) ?? null,
      entries: (earlier.get(week) ?? []).sort(byPresentation),
    });
  }
  return sections.filter((s) => s.entries.length > 0 || s.digest !== null);
}

/** Every entry of the feed, by key. */
export function entriesByKey(feed: WhatsNewFeed): Map<string, WhatsNewEntry> {
  return new Map(feed.days.flatMap((d) => d.entries.map((e) => [e.key, e] as const)));
}
