// What's new: the release this Forge instance is serving, read once per person (REQ-40 BC-10). The
// release is the one of the instance's own product project whose commit the running build is; what a
// person reads is its highlights and its lines, never the rest of the release page.

import type { RefusalStatuses } from "./refusal.js";
import type { ReleaseHighlights } from "./release-page.js";

/** The three filters a reader picks between. */
export const WHATS_NEW_KINDS = ["new", "improved", "fixed"] as const;
export type WhatsNewKind = (typeof WHATS_NEW_KINDS)[number];

/** The sections of a CHANGELOG version section that hold entries. */
export const WHATS_NEW_SECTIONS = [
	"Added",
	"Changed",
	"Fixed",
	"Removed",
	"Security",
] as const;
export type WhatsNewSection = (typeof WHATS_NEW_SECTIONS)[number];

/** Each section read as one kind. */
export const WHATS_NEW_KIND_OF_SECTION: Readonly<
	Record<WhatsNewSection, WhatsNewKind>
> = {
	Added: "new",
	Changed: "improved",
	Removed: "improved",
	Fixed: "fixed",
	Security: "fixed",
};

/** One line of a release: what changed for a reader, as its issue's user-facing note says it. */
export interface WhatsNewChange {
	kind: WhatsNewKind;
	line: string;
}

/** What the rail reads on every page: the serving release's version and whether it is owed to this person. */
export interface WhatsNewSummary {
	/** The instance's own name for where it runs: `dev`, `beta`, `production`. */
	environment: string;
	release: { version: string; owed: boolean } | null;
}

/** The release this instance serves, as What's new opens it. */
export interface WhatsNewRelease {
	version: string;
	releasedAt: string | null;
	owed: boolean;
	/** Each clip or picture is a short-lived link minted for this reader. */
	highlights: ReleaseHighlights;
	/** The release's new and improved lines, then its fixes. */
	changes: WhatsNewChange[];
}

export interface WhatsNewFeed {
	environment: string;
	/** Null where no release of the product project carries the commit this build runs. */
	release: WhatsNewRelease | null;
}

/** Words a digest body may spend. */
export const WHATS_NEW_DIGEST_WORDS_MAX = 120;

/** The words a digest body counts, as a reader would count them. */
export function digestWordCount(body: string): number {
	return body.trim().split(/\s+/u).filter(Boolean).length;
}

const WHATS_NEW_REFUSAL_CODES = [
	"WHATS_NEW_INSTANCE_UNSET",
	"WHATS_NEW_REFUSED",
] as const;
export type WhatsNewRefusalCode = (typeof WHATS_NEW_REFUSAL_CODES)[number];
export const WHATS_NEW_REFUSAL_STATUSES = {
	WHATS_NEW_INSTANCE_UNSET: 503,
} as const satisfies RefusalStatuses<WhatsNewRefusalCode>;
