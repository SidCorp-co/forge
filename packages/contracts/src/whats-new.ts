// What's new: Forge's own released changes, read by time rather than by version. An entry is one
// released issue's user-facing release note on the platform project; a digest is a short weekly
// summary an agent writes over that week's entries. Versions ship many times a week, so the version
// is only metadata on an entry, never the grouping.

import { z } from "zod";
import type { LandingSurface } from "./landing-artifacts.js";
import type { RefusalStatuses } from "./refusal.js";
import type { ReleaseNotesSection } from "./release-notes.js";

/** The three filters a reader picks between. */
export const WHATS_NEW_KINDS = ["new", "improved", "fixed"] as const;
export type WhatsNewKind = (typeof WHATS_NEW_KINDS)[number];

/** Each shipping release-note section read as one kind; `Skip` ships no note and is never an entry. */
export const WHATS_NEW_KIND_OF_SECTION: Readonly<
	Record<Exclude<ReleaseNotesSection, "Skip">, WhatsNewKind>
> = {
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

/** A tour an entry opens; null until a tour is wired to the entry's issue. */
export interface WhatsNewTourRef {
	id: string;
	revision: number;
}

export interface WhatsNewEntry {
	/** The issue key: what a digest names when it covers the entry. */
	key: string;
	section: Exclude<ReleaseNotesSection, "Skip">;
	kind: WhatsNewKind;
	text: string;
	/** The surfaces the landing named (`issues.merged_artifacts`); empty where it named none. */
	surfaces: LandingSurface[];
	/** Whether the landing changed a screen: a `ui` artifact. */
	ui: boolean;
	version: string;
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

export interface WhatsNewDigestView {
	week: string;
	title: string;
	body: string;
	entryKeys: string[];
	author: { name: string | null; agency: "human" | "agent" | null };
	writtenAt: string;
}

export interface WhatsNewCounts {
	new: number;
	screens: number;
	improved: number;
	fixed: number;
}

/** What a reader away for `WHATS_NEW_AWAY_DAYS` or more reads first. */
export interface WhatsNewAway {
	since: string;
	days: number;
	counts: WhatsNewCounts;
	/** The unread entries lifted out, new screens first. */
	highlights: string[];
}

export interface WhatsNewFeed {
	projectId: string;
	/** The platform project's slug, which an entry's version links into: its release page. */
	projectSlug: string | null;
	/** The platform project's content language, which the chrome is written in. */
	contentLanguage: string;
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

/** The week an agent writes a digest over: its entries and the digest already written, if any. */
export interface WhatsNewWeek {
	projectId: string;
	contentLanguage: string;
	week: string;
	from: string;
	to: string;
	entries: WhatsNewEntry[];
	digest: WhatsNewDigestView | null;
}

const WEEK = /^(\d{4})-W(\d{2})$/;
export const WEEK_SHAPE = "an ISO week `YYYY-Www` such as `2026-W41`, or `current` or `previous`";

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

/** A week named in a path, resolved against `now`: `current`, `previous`, or an ISO week. */
export function resolveWeek(text: string, now: Date): string | null {
	if (text === "current") return isoWeekOf(now);
	if (text === "previous") return isoWeekOf(new Date(now.getTime() - 7 * 86_400_000));
	return weekRange(text) ? text : null;
}

export const WHATS_NEW_DIGEST_WORDS_MAX = 120;
const WHATS_NEW_DIGEST_TITLE_MAX = 120;

export const putWhatsNewDigestRequestSchema = z.strictObject({
	title: z.string().trim().min(1).max(WHATS_NEW_DIGEST_TITLE_MAX),
	body: z.string().trim().min(1).max(2_000),
	entryKeys: z.array(z.string().trim().min(1).max(40)).min(1).max(200),
});
export type PutWhatsNewDigestRequest = z.infer<typeof putWhatsNewDigestRequestSchema>;
export const PUT_WHATS_NEW_DIGEST_SHAPE = `{ title: string (≤${WHATS_NEW_DIGEST_TITLE_MAX} chars), body: string (≤${WHATS_NEW_DIGEST_WORDS_MAX} words), entryKeys: string[] (≥1, each an entry key of that week) }`;

/** The words a digest body counts, as a reader would count them. */
export function digestWordCount(body: string): number {
	return body.trim().split(/\s+/u).filter(Boolean).length;
}

const WHATS_NEW_REFUSAL_CODES = [
	"WHATS_NEW_PLATFORM_UNSET",
	"WHATS_NEW_NOT_PLATFORM_PROJECT",
	"WHATS_NEW_WEEK_INVALID",
	"WHATS_NEW_WEEK_AHEAD",
	"WHATS_NEW_TIME_ZONE_UNKNOWN",
	"WHATS_NEW_DIGEST_TOO_LONG",
	"WHATS_NEW_DIGEST_FOREIGN_ENTRY",
	"WHATS_NEW_REFUSED",
] as const;
export type WhatsNewRefusalCode = (typeof WHATS_NEW_REFUSAL_CODES)[number];
export const WHATS_NEW_REFUSAL_STATUSES = {
	WHATS_NEW_PLATFORM_UNSET: 503,
	WHATS_NEW_WEEK_INVALID: 400,
	WHATS_NEW_TIME_ZONE_UNKNOWN: 400,
} as const satisfies RefusalStatuses<WhatsNewRefusalCode>;
