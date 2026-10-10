// The release page (REQ-40): one release as a reader reads it, built from Forge's own records. A
// projection of the release read model (`releases.ts:ReleaseDetail`) under one truth rule (BC-13):
// a criterion is claimed only with a pass verdict on the commit the release deploys.
// Everything else it says is a known issue. Design: docs/proposals/release-page.md.

import { z } from "zod";
import {
	CRITERION_STANDINGS,
	type CriterionStanding,
} from "./issue-vocabulary.js";
import type { Refusal, RefusalStatuses } from "./refusal.js";
import {
	RELEASE_STATES,
	RELEASE_VERIFICATIONS,
	RELEASE_VERIFIED_LEVELS,
	type ReleaseChanges,
	type ReleasePerson,
	type ReleaseState,
	type ReleaseVerified,
} from "./releases.js";
import {
	digestWordCount,
	WHATS_NEW_KINDS,
	type WhatsNewKind,
} from "./whats-new.js";

/** `user` reads what changed for them; `developer` adds the technical notes (BC-9). */
export const RELEASE_PAGE_VIEWS = ["user", "developer"] as const;
export type ReleasePageViewKind = (typeof RELEASE_PAGE_VIEWS)[number];

const COMMIT = /^[0-9a-f]{40}$/;
const MIB = 1024 * 1024;

// ---- media: a clip or a picture QA kept as verdict evidence (BC-3, BC-4) ----

export const RELEASE_CLIP_MIMES = ["video/webm", "video/mp4"] as const;
export const RELEASE_PICTURE_MIMES = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
] as const;
export const RELEASE_MEDIA_KINDS = ["clip", "picture"] as const;
export type ReleaseMediaKind = (typeof RELEASE_MEDIA_KINDS)[number];

/** One criterion's clip, as QA records it: short enough to watch inline, small enough to upload. */
export const RELEASE_CLIP_MAX_SECONDS = 20;
/** The deployment's default upload ceiling (`UPLOADS_MAX_BYTES`); a clip over it is re-recorded smaller, never the ceiling raised. */
export const RELEASE_CLIP_MAX_BYTES = 10 * MIB;

/** What a stored file shows on a release page, read off its type; null for a file no page shows. */
export function releaseMediaKindOf(mime: string): ReleaseMediaKind | null {
	if ((RELEASE_CLIP_MIMES as readonly string[]).includes(mime)) return "clip";
	if ((RELEASE_PICTURE_MIMES as readonly string[]).includes(mime))
		return "picture";
	return null;
}

/**
 * A file a release page shows: an issue attachment that a verdict's `evidence` cites by name. It
 * names the verdict and the build that verdict judged, so a reader can trace the picture to its proof.
 */
export const ReleaseMediaRefSchema = z.strictObject({
	kind: z.enum(RELEASE_MEDIA_KINDS),
	attachmentId: z.uuid(),
	name: z.string().min(1).max(180),
	mime: z.enum([...RELEASE_CLIP_MIMES, ...RELEASE_PICTURE_MIMES]),
	bytes: z.number().int().positive().max(RELEASE_CLIP_MAX_BYTES),
	verdictId: z.uuid(),
	issueKey: z.string().min(1),
	/** The issue criterion's number and the requirement criterion it traces to, where it traces. */
	criterion: z.strictObject({
		n: z.number().int().positive(),
		bc: z.string().nullable(),
	}),
	commitSha: z.string().regex(COMMIT, "a full 40-hex commit"),
	/** Where a reader fetches the file: set when the page is served or a share is opened, never stored. */
	url: z.string().min(1).optional(),
});
export type ReleaseMediaRef = z.infer<typeof ReleaseMediaRefSchema>;

// ---- the truth rule (BC-13, BC-8) ----

/** Why a criterion the release carries is not claimed: its verdict on this build, or none on it. */
export const RELEASE_KNOWN_ISSUE_STANDINGS = [
	"fail",
	"short",
	"skipped",
	"not_judged",
] as const;
export type ReleaseKnownIssueStanding =
	(typeof RELEASE_KNOWN_ISSUE_STANDINGS)[number];

export interface ReleaseVerdictReading {
	verdict: "pass" | "short" | "fail" | "skipped";
	identityKind: string | null;
	commitSha: string | null;
	at: string;
}

export type ReleaseClaim =
	| { claimed: true; at: string }
	| {
			claimed: false;
			standing: ReleaseKnownIssueStanding;
			/** The newest verdict on another build, so `not_judged` can say where it was judged instead. */
			elsewhere: {
				verdict: ReleaseVerdictReading["verdict"];
				commitSha: string | null;
			} | null;
	  };

/**
 * Whether a release page may claim a criterion: only the newest verdict whose identity is the commit
 * `build` counts, and only a pass is claimed. A short, a fail or a skip on the build is a known issue
 * as itself; a pass on any other commit, or no verdict on it, is `not_judged`. With no cut
 * build (`null`) nothing is claimed.
 */
export function releaseClaimOf(
	verdicts: readonly ReleaseVerdictReading[],
	build: string | null,
): ReleaseClaim {
	const newestFirst = [...verdicts].sort((a, b) => b.at.localeCompare(a.at));
	const onBuild =
		build === null
			? undefined
			: newestFirst.find(
					(v) => v.identityKind === "commit" && v.commitSha === build,
				);
	if (onBuild?.verdict === "pass") return { claimed: true, at: onBuild.at };
	if (onBuild)
		return { claimed: false, standing: onBuild.verdict, elsewhere: null };
	const other = newestFirst[0];
	return {
		claimed: false,
		standing: "not_judged",
		elsewhere: other
			? { verdict: other.verdict, commitSha: other.commitSha }
			: null,
	};
}

/**
 * The build a release describes and counts its criteria on: the commit it was cut at and deploys;
 * none on a draft nobody cut, and none where the record holds no full commit.
 */
export function releaseBuildOf(
	state: ReleaseState,
	head: string | null,
): string | null {
	if (state === "draft" || !head) return null;
	return COMMIT.test(head) ? head : null;
}

/**
 * The standing a release counts one criterion it carries by (BC-5, BC-13): the newest verdict on the
 * commit `build`, or `unjudged` where none is on it, so a verdict on an earlier build never counts
 * here; with no cut build (a draft) the newest verdict, which is what a draft is cut on. "Proven" is
 * `criterionCountsAsPass` of this, on every surface that counts a release's criteria: the release
 * record's totals and the page's list read the same rows by it.
 */
export function releaseStandingOf(
	verdicts: readonly ReleaseVerdictReading[],
	build: string | null,
): CriterionStanding {
	const newestFirst = [...verdicts].sort((a, b) => b.at.localeCompare(a.at));
	const counted =
		build === null
			? newestFirst[0]
			: newestFirst.find(
					(v) => v.identityKind === "commit" && v.commitSha === build,
				);
	if (!counted) return "unjudged";
	if (counted.identityKind === "commit_unresolved") return "unresolved";
	return counted.verdict;
}

// ---- highlights (BC-2, BC-3) ----

export const RELEASE_HIGHLIGHTS_MIN = 1;
export const RELEASE_HIGHLIGHTS_MAX = 3;
export const RELEASE_HIGHLIGHT_TITLE_MAX = 80;
export const RELEASE_HIGHLIGHT_BODY_WORDS_MAX = 40;

/**
 * One highlight as the assistant drafts it: one requirement the release completes or advances, what
 * it now does for the reader, the criteria it claims (each a pass on the build), and the clip or
 * picture that shows it — or, where that release's evidence holds none, why not.
 */
export const ReleaseHighlightSchema = z
	.strictObject({
		requirement: z.strictObject({
			key: z.string().min(1),
			title: z.string().min(1),
		}),
		title: z.string().trim().min(1).max(RELEASE_HIGHLIGHT_TITLE_MAX),
		body: z
			.string()
			.trim()
			.min(1)
			.refine((b) => digestWordCount(b) <= RELEASE_HIGHLIGHT_BODY_WORDS_MAX, {
				error: `a highlight body runs to ${RELEASE_HIGHLIGHT_BODY_WORDS_MAX} words at most`,
			}),
		/** The requirement's BC codes this highlight claims; never empty, since a highlight says something works. */
		claims: z.array(z.string().min(1)).min(1),
		media: ReleaseMediaRefSchema.nullable(),
		/** Set exactly when `media` is null: why no clip or picture shows it. */
		mediaGap: z.string().min(1).nullable(),
	})
	.refine((h) => (h.media === null) !== (h.mediaGap === null), {
		error:
			"a highlight carries media or says why it has none, never both and never neither",
		path: ["mediaGap"],
	});
export type ReleaseHighlight = z.infer<typeof ReleaseHighlightSchema>;

export const RELEASE_HIGHLIGHTS_STATES = [
	"drafted",
	"none",
	"pending",
	"failed",
] as const;
export type ReleaseHighlightsState = (typeof RELEASE_HIGHLIGHTS_STATES)[number];

/**
 * The release's highlights as stored and refreshed: `drafted` at the cut and again whenever a verdict
 * on the build changes what may be claimed; `none` where the release completes or advances no
 * requirement; `pending` while a draft is owed; `failed` with the refusal the last draft earned.
 */
export const ReleaseHighlightsSchema = z.discriminatedUnion("state", [
	z.strictObject({
		state: z.literal("drafted"),
		highlights: z
			.array(ReleaseHighlightSchema)
			.min(RELEASE_HIGHLIGHTS_MIN)
			.max(RELEASE_HIGHLIGHTS_MAX),
		/** The gateway model that wrote it, as the gateway names it. */
		model: z.string().min(1),
		draftedAt: z.iso.datetime({ offset: true }),
		/** A digest of the facts it was drafted from; a different digest means it is owed again. */
		sourceDigest: z.string().min(1),
	}),
	z.strictObject({ state: z.literal("none"), why: z.string().min(1) }),
	z.strictObject({
		state: z.literal("pending"),
		since: z.iso.datetime({ offset: true }),
	}),
	z.strictObject({
		state: z.literal("failed"),
		at: z.iso.datetime({ offset: true }),
		refusals: z.array(
			z.strictObject({
				code: z.string(),
				path: z.string(),
				detail: z.string(),
			}),
		),
	}),
]);
export type ReleaseHighlights = z.infer<typeof ReleaseHighlightsSchema>;

/**
 * What the drafter is shown, and the only thing a highlight may draw on: the Product record of each
 * requirement the release completes or advances (title, summary, criterion statements), the codes
 * the truth rule lets it claim, and the media that release's verdicts kept. Never the codebase.
 */
export interface ReleaseHighlightFacts {
	version: string;
	requirements: {
		key: string;
		title: string;
		/** The requirement's own words the drafter read: its tldr and its criterion statements. */
		text: string;
		completes: boolean;
		claimable: string[];
	}[];
	media: ReleaseMediaRef[];
}

const NUMERAL = /\d+(?:[.,:]\d+)*/g;
/** The figures a text states, as written. */
export function numeralsIn(text: string): string[] {
	return text.match(NUMERAL) ?? [];
}

/**
 * Every reason a set of drafted highlights may not be shown, by the code a refusal names it with; an
 * empty list means it may. A drafter that earns a refusal retries once with it, then stores `failed`.
 */
export function judgeHighlights(
	highlights: readonly ReleaseHighlight[],
	facts: ReleaseHighlightFacts,
): Refusal[] {
	const out: Refusal[] = [];
	const want =
		facts.requirements.length === 0
			? "none, since the release completes or advances no requirement"
			: `${RELEASE_HIGHLIGHTS_MIN} to ${Math.min(RELEASE_HIGHLIGHTS_MAX, facts.requirements.length)}`;
	const max = Math.min(RELEASE_HIGHLIGHTS_MAX, facts.requirements.length);
	const min = Math.min(RELEASE_HIGHLIGHTS_MIN, max);
	if (highlights.length < min || highlights.length > max)
		out.push({
			code: "RELEASE_HIGHLIGHT_COUNT",
			path: "highlights",
			detail: `${highlights.length} highlights; this release takes ${want}`,
		});
	const seen = new Set<string>();
	highlights.forEach((h, i) => {
		const at = `highlights.${i}`;
		const req = facts.requirements.find((r) => r.key === h.requirement.key);
		if (!req) {
			out.push({
				code: "RELEASE_HIGHLIGHT_REQUIREMENT_FOREIGN",
				path: `${at}.requirement`,
				detail: `${h.requirement.key} is not a requirement ${facts.version} completes or advances`,
			});
			return;
		}
		if (seen.has(req.key))
			out.push({
				code: "RELEASE_HIGHLIGHT_REPEATED",
				path: `${at}.requirement`,
				detail: `${req.key} already has a highlight; one highlight per requirement`,
			});
		seen.add(req.key);
		for (const code of h.claims)
			if (!req.claimable.includes(code))
				out.push({
					code: "RELEASE_HIGHLIGHT_UNCLAIMED",
					path: `${at}.claims`,
					detail: `${req.key} ${code} has no pass verdict on the build ${facts.version} describes`,
				});
		const backed = new Set(
			numeralsIn(`${req.title} ${req.text} ${facts.version}`),
		);
		for (const n of numeralsIn(`${h.title} ${h.body}`))
			if (!backed.has(n))
				out.push({
					code: "RELEASE_HIGHLIGHT_FIGURE_UNBACKED",
					path: at,
					detail: `"${n}" is not a figure ${req.key}'s record states`,
				});
		const showable = facts.media.filter(
			(m) => m.criterion.bc !== null && h.claims.includes(m.criterion.bc),
		);
		if (h.media) {
			const media = h.media;
			if (!showable.some((m) => m.attachmentId === media.attachmentId))
				out.push({
					code: "RELEASE_HIGHLIGHT_MEDIA_FOREIGN",
					path: `${at}.media`,
					detail: `${media.name} is not evidence of a criterion this highlight claims in ${facts.version}`,
				});
		} else if (showable.length > 0) {
			out.push({
				code: "RELEASE_HIGHLIGHT_MEDIA_MISSED",
				path: `${at}.media`,
				detail: `${showable.length} clip or picture of its claims is kept (${showable[0]?.name}); a highlight shows one`,
			});
		}
	});
	return out;
}

// ---- the page (BC-1, BC-5..9, BC-12) ----

/**
 * Who approved it (BC-1), and whether the release setting asked anyone to (BC-12): `not_asked` where
 * it asks nobody and nobody approved of their own accord; an approval given anyway still shows.
 */
export interface ReleasePageApproval {
	required: boolean;
	state: "not_asked" | "pending" | "approved" | "returned";
	by: ReleasePerson | null;
	at: string | null;
}

export interface ReleasePageHeader {
	version: string;
	state: ReleaseState;
	releasedAt: string | null;
	/** Where it runs: the production environment the release was verified on. */
	environment: { name: string | null; url: string | null } | null;
	/** The build the page describes: the commit the release was cut at and deploys; null on a draft nobody cut. `verified` says whether it was proven live. */
	build: string | null;
	verified: ReleaseVerified;
	approval: ReleasePageApproval;
}

/**
 * One carried criterion proven on `header.build` (`criterionCountsAsPass` of `releaseStandingOf`), in
 * its own wording, so two criteria proving one requirement criterion read apart: `issueKey` and `n`
 * name it, `code` is the requirement criterion it traces (null where it traces none), and `short`
 * marks one met but short of its wording.
 */
export interface ReleasePageProven {
	code: string | null;
	statement: string;
	short: boolean;
	issueKey: string | null;
	/** Its number on its issue; null on a share frozen before rows carried it. */
	n: number | null;
}

/** The carried criteria of one group, each row one issue criterion: what the header counts, listed. */
export interface ReleasePageCriteria {
	proven: ReleasePageProven[];
	/** How many of its carried issue criteria are not proven on the build: the known issues among them. */
	unproven: number;
}

/** One requirement criterion the build proves, said once in its own wording: the rows tracing it prove it. */
export interface ReleasePageCode {
	code: string;
	statement: string;
}

export interface ReleasePageRequirement extends ReleasePageCriteria {
	key: string;
	title: string;
	completes: boolean;
	/**
	 * The requirement's own criteria, counted in them: how many are live, and each the build proves
	 * (one proven row tracing it is enough), in code order. Null on a share frozen before it was counted.
	 */
	business: { total: number; proven: ReleasePageCode[] } | null;
}

/** One user-facing line (`customer-notes.ts:customerNotes` output), with the kind its section reads as. */
export interface ReleasePageChange {
	issueKey: string;
	kind: WhatsNewKind;
	line: string;
}

/** What an admin must do once the release lands (BC-7). */
export const RELEASE_ACTION_KINDS = [
	"setting",
	"migration",
	"permission",
] as const;
export type ReleaseActionKind = (typeof RELEASE_ACTION_KINDS)[number];

export interface ReleaseActionItem {
	kind: ReleaseActionKind;
	/** The act, in a sentence an admin follows. */
	sentence: string;
	/** The artifact that owes it: a migration file, a permission key, a project-config path. */
	ref: string;
	issues: string[];
}

export interface ReleaseKnownIssue {
	issueKey: string;
	requirementKey: string | null;
	bc: string | null;
	statement: string;
	standing: ReleaseKnownIssueStanding;
	reason: string | null;
	elsewhere: { verdict: CriterionStanding; commitSha: string | null } | null;
}

/**
 * What the release's own commit range ships, as the run that cut it reported it from its checkout
 * (`ReleaseRangeReport`) rather than what an issue filled in (BC-7, BC-9): `base` is the commit the
 * previous shipped release served and `head` the commit this one deploys. A range not reported, or
 * reported for another head, says why, so a page never reads "None" for what nobody looked at.
 */
export type ReleaseShipped =
	| {
			state: "read";
			base: string;
			head: string;
			/** Migration files the range adds to the journal, as `<dir>/<tag>.sql`. */
			migrations: string[];
			/** Operations of the generated API contract the range adds, changes or removes: `added GET /api/x`. */
			contracts: string[];
			/** Package dependency moves: `packages/core: hono 4.1.0 -> 4.2.0`. */
			dependencies: string[];
			/** Environment settings a deployment file of the range names that its base did not. */
			settings: { name: string; required: boolean }[];
	  }
	| { state: "unread"; why: string };

/** The changed files of a range, as the release run's checkout names them; a rename is its old path removed and its new one added. */
export const RELEASE_RANGE_CHANGES = ["added", "changed", "removed"] as const;

const RangeChangeSchema = z.strictObject({
	path: z.string().trim().min(1).max(1000),
	change: z.enum(RELEASE_RANGE_CHANGES),
});

/** The release run asks which of its range's changed files the reader reads. */
export const ReleaseRangeReadsBodySchema = z.strictObject({
	changes: z.array(RangeChangeSchema).max(20_000),
});

/**
 * What the run that cut a release reports of its range (BC-7, BC-9), from the checkout on its box:
 * every file changed `base...head`, and the text at each end of each file the reader reads (`null`
 * where the file does not exist at that end). Core reads it with the one reader and keeps the
 * reading on the release run; no source host is called.
 */
export const ReleaseRangeReportSchema = z.strictObject({
	base: z.string().regex(COMMIT, "base is a full 40-hex commit"),
	head: z.string().regex(COMMIT, "head is a full 40-hex commit"),
	changes: z.array(RangeChangeSchema).max(20_000),
	files: z
		.array(
			z.strictObject({
				path: z.string().trim().min(1).max(1000),
				base: z.string().nullable(),
				head: z.string().nullable(),
			}),
		)
		.max(200),
});
export type ReleaseRangeReport = z.infer<typeof ReleaseRangeReportSchema>;

/** Where a release run's range starts: the commit the release shipped before it served, or why there is none. */
export type ReleaseRangeBase =
	| { base: string; why: null }
	| { base: null; why: string };

/** The developer view's addition (BC-9). */
export interface ReleaseTechnicalNotes {
	notes: { issueKey: string; title: string; technical: string }[];
	migrations: string[];
	contracts: string[];
	dependencies: string[];
	/** New environment settings, each saying whether the deployment refuses to start without it. */
	settings: string[];
	changes: ReleaseChanges;
}

/**
 * An issue the release carries whose user-facing line the page does not show, named rather than
 * invented: `no_note` where it has none, `held` where its line names what a reader cannot follow.
 */
export interface ReleasePageUnnoted {
	issueKey: string;
	title: string;
	why: "no_note" | "held";
}

export interface ReleasePage {
	view: ReleasePageViewKind;
	projectId: string;
	header: ReleasePageHeader;
	highlights: ReleaseHighlights;
	requirements: ReleasePageRequirement[];
	/** The carried criteria of issues that trace no requirement; null where every issue traces one. */
	untraced: ReleasePageCriteria | null;
	improvements: ReleasePageChange[];
	fixes: ReleasePageChange[];
	withoutNotes: ReleasePageUnnoted[];
	actionRequired: ReleaseActionItem[];
	/** What the commit range was read as: where it is unread, "nothing required" is not claimed. */
	shipped: ReleaseShipped;
	knownIssues: ReleaseKnownIssue[];
	/** Null on the user view. */
	technical: ReleaseTechnicalNotes | null;
	can: { share: boolean; export: boolean; approve: boolean };
}

const ISO = z.iso.datetime({ offset: true });
const PersonSchema = z.strictObject({
	id: z.string().min(1),
	name: z.string(),
	kind: z.enum(["human", "agent"]),
});
// a share frozen before every carried criterion was listed has a code on each row and no issue key;
// one frozen before rows carried their own wording has no number, its row saying the code's wording
const ProvenSchema = z.strictObject({
	code: z.string().min(1).nullable(),
	statement: z.string(),
	short: z.boolean().default(false),
	issueKey: z.string().min(1).nullable().default(null),
	n: z.number().int().min(1).nullable().default(null),
});
const ChangeSchema = z.strictObject({
	issueKey: z.string().min(1),
	kind: z.enum(WHATS_NEW_KINDS),
	line: z.string().min(1),
});

/**
 * The user view of a release page as a share freezes it (BC-11): every section a reader sees, no
 * technical notes, and nothing a reader of the link may act on. A frozen page that does not parse is
 * refused, never stored half-readable.
 */
export const ReleasePageSnapshotSchema = z.strictObject({
	view: z.literal("user"),
	projectId: z.uuid(),
	header: z.strictObject({
		version: z.string().min(1),
		state: z.enum(RELEASE_STATES),
		releasedAt: ISO.nullable(),
		environment: z
			.strictObject({ name: z.string().nullable(), url: z.string().nullable() })
			.nullable(),
		build: z.string().regex(COMMIT, "a full 40-hex commit").nullable(),
		verified: z.strictObject({
			level: z.enum(RELEASE_VERIFIED_LEVELS),
			proven: z.number().int().min(0),
			total: z.number().int().min(0),
			check: z.enum(RELEASE_VERIFICATIONS).nullable(),
			provider: z.string().nullable(),
		}),
		approval: z.strictObject({
			required: z.boolean(),
			state: z.enum(["not_asked", "pending", "approved", "returned"]),
			by: PersonSchema.nullable(),
			at: ISO.nullable(),
		}),
	}),
	highlights: ReleaseHighlightsSchema,
	requirements: z.array(
		z.strictObject({
			key: z.string().min(1),
			title: z.string().min(1),
			completes: z.boolean(),
			proven: z.array(ProvenSchema),
			unproven: z.number().int().min(0),
			business: z
				.strictObject({
					total: z.number().int().min(0),
					proven: z.array(
						z.strictObject({ code: z.string().min(1), statement: z.string() }),
					),
				})
				.nullable()
				.default(null),
		}),
	),
	untraced: z
		.strictObject({
			proven: z.array(ProvenSchema),
			unproven: z.number().int().min(0),
		})
		.nullable()
		.default(null),
	improvements: z.array(ChangeSchema),
	fixes: z.array(ChangeSchema),
	withoutNotes: z.array(
		z.strictObject({
			issueKey: z.string().min(1),
			title: z.string(),
			why: z.enum(["no_note", "held"]),
		}),
	),
	actionRequired: z.array(
		z.strictObject({
			kind: z.enum(RELEASE_ACTION_KINDS),
			sentence: z.string().min(1),
			ref: z.string().min(1),
			issues: z.array(z.string().min(1)),
		}),
	),
	/** A share frozen before the range was read says so: it never claims nothing was required. */
	shipped: z
		.discriminatedUnion("state", [
			z.strictObject({
				state: z.literal("read"),
				base: z.string().min(1),
				head: z.string().min(1),
				migrations: z.array(z.string()),
				contracts: z.array(z.string()),
				dependencies: z.array(z.string()),
				settings: z.array(
					z.strictObject({ name: z.string(), required: z.boolean() }),
				),
			}),
			z.strictObject({ state: z.literal("unread"), why: z.string().min(1) }),
		])
		.default({
			state: "unread",
			why: "this page was shared before it read the commit range, so what it requires of an admin is not recorded here",
		}),
	knownIssues: z.array(
		z.strictObject({
			issueKey: z.string().min(1),
			requirementKey: z.string().nullable(),
			bc: z.string().nullable(),
			statement: z.string(),
			standing: z.enum(RELEASE_KNOWN_ISSUE_STANDINGS),
			reason: z.string().nullable(),
			elsewhere: z
				.strictObject({
					verdict: z.enum(CRITERION_STANDINGS),
					commitSha: z.string().nullable(),
				})
				.nullable(),
		}),
	),
	technical: z.null(),
	can: z.strictObject({
		share: z.boolean(),
		export: z.boolean(),
		approve: z.boolean(),
	}),
});
export type ReleasePageSnapshot = z.infer<typeof ReleasePageSnapshotSchema>;

/** A frozen page is a page: what reads one reads the other. */
export function releasePageOfSnapshot(
	snapshot: ReleasePageSnapshot,
): ReleasePage {
	return snapshot;
}

/** Where a reader's client reads one release page. */
export function releasePagePath(
	projectId: string,
	version: string,
	view: ReleasePageViewKind,
): string {
	return `/api/projects/${projectId}/releases/${encodeURIComponent(version)}/page?view=${view}`;
}

/** What a release page exports as (BC-11): the Markdown text, and a message a person sends. */
export const RELEASE_PAGE_EXPORT_FORMATS = ["markdown", "email"] as const;
export type ReleasePageExportFormat =
	(typeof RELEASE_PAGE_EXPORT_FORMATS)[number];

// ---- What's new, once per person per environment (BC-10) ----

/** The release a person last opened What's new on, in the environment it served. */
export const ReleaseSeenSchema = z.strictObject({
	environment: z.string().trim().min(1).max(200),
	version: z.string().trim().min(1).max(100),
	at: z.iso.datetime({ offset: true, error: "at is an ISO 8601 date-time" }),
});
export type ReleaseSeen = z.infer<typeof ReleaseSeenSchema>;

/**
 * Whether What's new opens by itself for a person: once, when the environment serves a release newer
 * than the one they last saw there. A rollback to an older version opens nothing; another environment
 * is its own count.
 */
export function whatsNewReleaseOwed(
	seen: ReleaseSeen | null,
	serving: { environment: string; version: string } | null,
): boolean {
	if (serving === null) return false;
	if (seen === null || seen.environment !== serving.environment) return true;
	return (
		serving.version.localeCompare(seen.version, "en", { numeric: true }) > 0
	);
}

// ---- refusals ----

export const RELEASE_PAGE_REFUSAL_CODES = [
	"RELEASE_PAGE_NOT_FOUND",
	"RELEASE_PAGE_VIEW_UNKNOWN",
	"RELEASE_PAGE_EXPORT_FORMAT_UNKNOWN",
	/** A drafted answer that is not the highlights' JSON shape, or a highlight its schema refuses. */
	"RELEASE_HIGHLIGHT_SHAPE",
	"RELEASE_HIGHLIGHT_COUNT",
	"RELEASE_HIGHLIGHT_REQUIREMENT_FOREIGN",
	"RELEASE_HIGHLIGHT_REPEATED",
	"RELEASE_HIGHLIGHT_UNCLAIMED",
	"RELEASE_HIGHLIGHT_FIGURE_UNBACKED",
	"RELEASE_HIGHLIGHT_MEDIA_FOREIGN",
	"RELEASE_HIGHLIGHT_MEDIA_MISSED",
	/** No gateway model is configured, so no highlight can be drafted; never a direct provider key. */
	"RELEASE_HIGHLIGHTS_MODEL_UNCONFIGURED",
	/** The project's data policy keeps its requirements from a model, so nothing was drafted. */
	"RELEASE_HIGHLIGHTS_WITHHELD",
	/** The gateway call failed; the next refresh drafts again. */
	"RELEASE_HIGHLIGHTS_MODEL_FAILED",
	/** A seen mark for a version the environment does not serve. */
	"RELEASE_SEEN_NOT_SERVING",
	/** The running instance declares no environment name to count a seen mark against. */
	"RELEASE_SEEN_ENVIRONMENT_UNKNOWN",
] as const;
export type ReleasePageRefusalCode =
	(typeof RELEASE_PAGE_REFUSAL_CODES)[number];
export const RELEASE_PAGE_REFUSAL_STATUSES = {
	RELEASE_PAGE_NOT_FOUND: 404,
	RELEASE_PAGE_VIEW_UNKNOWN: 400,
	RELEASE_PAGE_EXPORT_FORMAT_UNKNOWN: 400,
	RELEASE_HIGHLIGHTS_MODEL_UNCONFIGURED: 503,
	RELEASE_SEEN_NOT_SERVING: 409,
	RELEASE_SEEN_ENVIRONMENT_UNKNOWN: 503,
} as const satisfies RefusalStatuses<ReleasePageRefusalCode>;
