// A release page read in thirty seconds: the summary it opens on, its changes counted by the group a
// reader looks for, and each change as one short row. Pure, over the page the reader already holds
// (`release-page.ts:ReleasePage`), so the app, a frozen share and an export read it alike. The full
// line, the issue and the criteria behind a row are that row's disclosure, never the page's default.

import type { Refusal } from "./refusal.js";
import type { ReleasePage, ReleasePageChange } from "./release-page.js";

/** The most words a change's row says before its full line moves behind the row's disclosure. */
export const RELEASE_ROW_WORDS_MAX = 15;

/** The groups a reader scans a release by, in reading order; Security is its own group, never folded into fixes. */
export const RELEASE_CHANGE_GROUPS = [
	"new",
	"improved",
	"fixed",
	"security",
] as const;
export type ReleaseChangeGroup = (typeof RELEASE_CHANGE_GROUPS)[number];

export function releaseChangeGroupOf(c: ReleasePageChange): ReleaseChangeGroup {
	return c.section === "Security" ? "security" : c.kind;
}

const wordsOf = (text: string) => text.split(/\s+/u).filter(Boolean);
const SENTENCE_END = /^(.+?)[.;!?](?:\s|$)/u;
/** A comma this far in or later is a clause worth stopping at, rather than a stub. */
const CLAUSE_WORDS_MIN = 6;

/**
 * A change's row: its line's first sentence, and where that runs past `RELEASE_ROW_WORDS_MAX` words,
 * its last clause that fits, or else its first words and an ellipsis. `cut` says the row says less
 * than the line, so the reader is offered the rest.
 */
export function releaseRowHeadline(line: string): {
	text: string;
	cut: boolean;
} {
	const whole = line.trim();
	const sentence = (SENTENCE_END.exec(whole)?.[1] ?? whole).trim();
	const words = wordsOf(sentence);
	const rest = wordsOf(whole).length > words.length;
	if (words.length <= RELEASE_ROW_WORDS_MAX)
		return { text: sentence, cut: rest };
	const head = words.slice(0, RELEASE_ROW_WORDS_MAX);
	let comma = -1;
	head.forEach((w, i) => {
		if (w.endsWith(",")) comma = i;
	});
	if (comma + 1 >= CLAUSE_WORDS_MIN)
		return {
			text: head
				.slice(0, comma + 1)
				.join(" ")
				.replace(/,$/u, ""),
			cut: true,
		};
	return { text: `${head.join(" ")}…`, cut: true };
}

/** What a release holds, counted the way its summary and its at-a-glance row read it. */
export interface ReleaseGlance {
	groups: Record<ReleaseChangeGroup, ReleasePageChange[]>;
	/** Issues it carries with no line for users (`withoutNotes`). */
	other: number;
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
		completes: page.requirements.filter((r) => r.completes),
		advances: page.requirements.filter((r) => !r.completes),
		open: {
			checks: page.knownIssues.length,
			issues: new Set(page.knownIssues.map((k) => k.issueKey)).size,
		},
	};
}

const GROUP_NOUN: Record<ReleaseChangeGroup, [string, string]> = {
	new: ["new feature", "new features"],
	improved: ["improvement", "improvements"],
	fixed: ["fix", "fixes"],
	security: ["security fix", "security fixes"],
};

const counted = (n: number, [one, many]: [string, string]) =>
	`${n} ${n === 1 ? one : many}`;

/** "a, b and c". */
function listed(parts: string[]): string {
	if (parts.length <= 1) return parts.join("");
	return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

const NAMED_MAX = 2;
/** Up to two titles quoted, then how many more. */
function titles(rows: ReleasePage["requirements"]): string {
	const named = rows.slice(0, NAMED_MAX).map((r) => `“${r.title}”`);
	const more = rows.length - named.length;
	return listed(more > 0 ? [...named, `${more} more`] : named);
}

export type ReleaseSummary =
	| { state: "derived"; lines: string[] }
	| { state: "refused"; refusal: Refusal };

/**
 * Two to four plain lines a product owner reads first: what the release brings by group, the
 * requirements it completes or moves forward, its drafted highlights, and what is still open. Every
 * figure is a count of the page's own rows; nothing is invented. A release with no change and no
 * requirement has nothing to summarise and is refused by name rather than given a filler line.
 */
export function releaseSummaryOf(page: ReleasePage): ReleaseSummary {
	const g = releaseGlanceOf(page);
	const noted = RELEASE_CHANGE_GROUPS.filter((k) => g.groups[k].length > 0);
	if (noted.length === 0 && g.other === 0 && page.requirements.length === 0)
		return {
			state: "refused",
			refusal: {
				code: "RELEASE_SUMMARY_UNDERIVABLE",
				path: "summary",
				detail: `release ${page.header.version} carries no change and completes or advances no requirement, so there is nothing to summarise`,
			},
		};
	const lines: string[] = [];
	const brings = noted.map((k) => counted(g.groups[k].length, GROUP_NOUN[k]));
	const unnoted = counted(g.other, [
		"change with no note for users yet",
		"changes with no note for users yet",
	]);
	if (brings.length > 0)
		lines.push(
			`This release brings ${listed(brings)}${g.other > 0 ? `, plus ${unnoted}` : ""}.`,
		);
	else if (g.other > 0) lines.push(`This release carries ${unnoted}.`);
	const reqs = [
		...(g.completes.length > 0 ? [`completes ${titles(g.completes)}`] : []),
		...(g.advances.length > 0 ? [`moves ${titles(g.advances)} forward`] : []),
	];
	if (reqs.length > 0) lines.push(`It ${listed(reqs)}.`);
	if (page.highlights.state === "drafted")
		lines.push(
			`Highlights: ${listed(page.highlights.highlights.map((h) => h.title))}.`,
		);
	if (g.open.checks > 0)
		lines.push(
			`${counted(g.open.checks, ["acceptance check is", "acceptance checks are"])} still open on ${counted(g.open.issues, ["change", "changes"])}.`,
		);
	return { state: "derived", lines };
}
