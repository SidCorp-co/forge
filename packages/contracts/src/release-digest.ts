// A release page read in thirty seconds: its changes counted by the group a reader looks for, and the
// shortened overview the release list's peek shows (REQ-40 BC-18). Pure, over the page the reader
// already holds (`release-page.ts:ReleasePage`), so the app, a frozen share and an export read it
// alike. Every change is shown whole as its note wrote it: nothing here cuts a line (BC-6).

import type { ReleasePage, ReleasePageChange } from "./release-page.js";

/** The groups a reader scans a release by, in reading order; Security and Removed are their own groups. */
export const RELEASE_CHANGE_GROUPS = [
	"new",
	"improved",
	"fixed",
	"security",
	"removed",
] as const;
export type ReleaseChangeGroup = (typeof RELEASE_CHANGE_GROUPS)[number];

export function releaseChangeGroupOf(c: ReleasePageChange): ReleaseChangeGroup {
	if (c.section === "Security") return "security";
	if (c.section === "Removed") return "removed";
	return c.kind;
}

/** What a release holds, counted the way its tally line and its peek read it. */
export interface ReleaseGlance {
	groups: Record<ReleaseChangeGroup, ReleasePageChange[]>;
	/** Issues it carries with no line for users (`withoutNotes`). */
	other: number;
	/** Changes nobody using the product sees (REQ-40 BC-16), counted apart. */
	internal: number;
	completes: ReleasePage["requirements"];
	advances: ReleasePage["requirements"];
	/** Carried criteria not proven on the build (`knownIssues`), and how many issues they sit on. */
	open: { checks: number; issues: number };
}

export function releaseGlanceOf(page: ReleasePage): ReleaseGlance {
	const groups = Object.fromEntries(
		RELEASE_CHANGE_GROUPS.map((g) => [g, [] as ReleasePageChange[]]),
	) as Record<ReleaseChangeGroup, ReleasePageChange[]>;
	for (const c of [...page.improvements, ...page.fixes])
		groups[releaseChangeGroupOf(c)].push(c);
	return {
		groups,
		other: page.withoutNotes.length,
		internal: page.internal.count,
		completes: page.requirements.filter((r) => r.completes),
		advances: page.requirements.filter((r) => !r.completes),
		open: {
			checks: page.knownIssues.length,
			issues: new Set(page.knownIssues.map((k) => k.issueKey)).size,
		},
	};
}

/** The changes in the order a reader scans them: by group, each group as the page lists it. */
export function releaseChangesInOrder(page: ReleasePage): {
	group: ReleaseChangeGroup;
	change: ReleasePageChange;
}[] {
	const { groups } = releaseGlanceOf(page);
	return RELEASE_CHANGE_GROUPS.flatMap((group) =>
		groups[group].map((change) => ({ group, change })),
	);
}

/** The most change lines the peek shows before it says how many more the page holds (REQ-40 BC-18). */
export const RELEASE_PEEK_LINES_MAX = 8;

/** The overview the peek shows, shortened: the first lines whole, and how many more the page holds. */
export function releasePeekLines(page: ReleasePage): {
	shown: { group: ReleaseChangeGroup; change: ReleasePageChange }[];
	more: number;
} {
	const all = releaseChangesInOrder(page);
	return {
		shown: all.slice(0, RELEASE_PEEK_LINES_MAX),
		more: Math.max(0, all.length - RELEASE_PEEK_LINES_MAX),
	};
}
