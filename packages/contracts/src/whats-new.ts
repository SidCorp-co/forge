// What's new: Forge's own released changes, read by time rather than by version. An entry is one
// bullet of the running build's CHANGELOG.md; a digest is the short weekly summary a release folds
// in under `### Digest`. Versions ship many times a week, so the version is only metadata on an
// entry, never the grouping.

import type { RefusalStatuses } from "./refusal.js";

/** The three filters a reader picks between. */
export const WHATS_NEW_KINDS = ["new", "improved", "fixed"] as const;
export type WhatsNewKind = (typeof WHATS_NEW_KINDS)[number];

/** The sections of a CHANGELOG version section that hold entries. */
export const WHATS_NEW_SECTIONS = ["Added", "Changed", "Fixed", "Removed", "Security"] as const;
export type WhatsNewSection = (typeof WHATS_NEW_SECTIONS)[number];

/** Each section read as one kind. */
export const WHATS_NEW_KIND_OF_SECTION: Readonly<Record<WhatsNewSection, WhatsNewKind>> = {
	Added: "new",
	Changed: "improved",
	Removed: "improved",
	Fixed: "fixed",
	Security: "fixed",
};

/** A reader who has not opened What's new for this long reads a summary first. */
export const WHATS_NEW_AWAY_DAYS = 7;
/** How far back the feed reads when the reader's mark is recent or absent. */
export const WHATS_NEW_WINDOW_DAYS = 30;
/** How far back the feed reads at most, however long the reader was away. */
export const WHATS_NEW_MAX_WINDOW_DAYS = 90;
/** How many unread entries an away summary lifts out as highlights. */
export const WHATS_NEW_HIGHLIGHTS = 3;

/** A tour an entry opens: the `tour:` line its changelog fragment carried, at the catalog's revision. */
export interface WhatsNewTourRef {
	id: string;
	revision: number;
}

export interface WhatsNewEntry {
	/** `<version>#<n>`: the entry's place in its version section, stable for the build. */
	key: string;
	section: WhatsNewSection;
	kind: WhatsNewKind;
	/** The bold lead of the bullet: what changed for the reader. */
	title: string;
	/** The rest of the bullet; empty when the lead says it all. */
	body: string;
	version: string;
	/** The version's date, at 00:00 UTC. */
	releasedAt: string;
	/** The ISO week the release shipped in, in UTC: `2026-W41`. */
	week: string;
	unread: boolean;
	tour: WhatsNewTourRef | null;
}

/** One calendar day of entries in the reader's time zone, newest day first. */
export interface WhatsNewDay {
	date: string;
	entries: WhatsNewEntry[];
}

/** A week's summary, as the release that carried it folded it in. */
export interface WhatsNewDigestView {
	week: string;
	title: string;
	body: string;
	version: string;
	releasedAt: string;
}

export interface WhatsNewCounts {
	new: number;
	improved: number;
	fixed: number;
}

/** What a reader away for `WHATS_NEW_AWAY_DAYS` or more reads first. */
export interface WhatsNewAway {
	since: string;
	days: number;
	counts: WhatsNewCounts;
	/** The unread entries lifted out, new ones first. */
	highlights: string[];
}

export interface WhatsNewFeed {
	/** The version of the build that answered: the newest section of its CHANGELOG.md. */
	version: string | null;
	seenAt: string | null;
	/** The earliest release the feed read from. */
	since: string;
	timeZone: string;
	unread: number;
	/** The unread entries by kind. */
	counts: WhatsNewCounts;
	away: WhatsNewAway | null;
	days: WhatsNewDay[];
	digests: WhatsNewDigestView[];
}

const WEEK = /^(\d{4})-W(\d{2})$/;
/** The ISO 8601 week a moment falls in, read in UTC. */
export function isoWeekOf(at: Date): string {
	const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
	const weekday = day.getUTCDay() || 7;
	day.setUTCDate(day.getUTCDate() + 4 - weekday);
	const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
	const n = Math.ceil(((day.getTime() - yearStart) / 86_400_000 + 1) / 7);
	return `${day.getUTCFullYear()}-W${String(n).padStart(2, "0")}`;
}

/** The UTC Monday a week starts on and the Monday after it, or null for text that names no week. */
export function weekRange(week: string): { from: Date; to: Date } | null {
	const m = WEEK.exec(week);
	if (!m) return null;
	const year = Number(m[1]);
	const n = Number(m[2]);
	const jan4 = new Date(Date.UTC(year, 0, 4));
	const monday = new Date(jan4);
	monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() || 7) - 1) + (n - 1) * 7);
	if (n < 1 || isoWeekOf(monday) !== week) return null;
	const to = new Date(monday);
	to.setUTCDate(monday.getUTCDate() + 7);
	return { from: monday, to };
}

/** Words a digest body may spend. */
export const WHATS_NEW_DIGEST_WORDS_MAX = 120;
export const WHATS_NEW_DIGEST_TITLE_MAX = 120;

/** The words a digest body counts, as a reader would count them. */
export function digestWordCount(body: string): number {
	return body.trim().split(/\s+/u).filter(Boolean).length;
}

const WHATS_NEW_REFUSAL_CODES = ["WHATS_NEW_TIME_ZONE_UNKNOWN", "WHATS_NEW_REFUSED"] as const;
export type WhatsNewRefusalCode = (typeof WHATS_NEW_REFUSAL_CODES)[number];
export const WHATS_NEW_REFUSAL_STATUSES = {
	WHATS_NEW_TIME_ZONE_UNKNOWN: 400,
} as const satisfies RefusalStatuses<WhatsNewRefusalCode>;
