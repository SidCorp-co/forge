import { isoWeekOf } from "@forge/contracts/whats-new";
import type { WhatsNewEntry, WhatsNewFeed } from "./types";

/** Wednesday 2026-10-07 10:00 UTC: this week is 2026-W41, which began Monday 05/10. */
export const NOW = new Date("2026-10-07T10:00:00Z");

export function entry(key: string, kind: WhatsNewEntry["kind"], releasedAt: string, extra: Partial<WhatsNewEntry> = {}): WhatsNewEntry {
  return {
    key,
    section: kind === "new" ? "Added" : kind === "improved" ? "Changed" : "Fixed",
    kind,
    title: `${key} title.`,
    body: `${key} body`,
    version: "0.4.0-dev.87",
    releasedAt,
    week: isoWeekOf(new Date(releasedAt)),
    unread: true,
    tour: null,
    ...extra,
  };
}

export function feedOf(entries: WhatsNewEntry[], extra: Partial<WhatsNewFeed> = {}): WhatsNewFeed {
  const byDate = new Map<string, WhatsNewEntry[]>();
  for (const e of entries) {
    const date = e.releasedAt.slice(0, 10);
    byDate.set(date, [...(byDate.get(date) ?? []), e]);
  }
  return {
    version: "0.4.0-dev.87",
    seenAt: "2026-10-03T08:00:00Z",
    since: "2026-09-07T10:00:00Z",
    timeZone: "UTC",
    unread: entries.filter((e) => e.unread).length,
    counts: { new: 0, improved: 0, fixed: 0 },
    away: null,
    days: [...byDate.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([date, list]) => ({ date, entries: list })),
    digests: [],
    ...extra,
  };
}
