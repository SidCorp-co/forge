// The sources a project learns from first (ISS-1252, owner 2026-11-16): repos, products, projects,
// patterns and docs a project trusts for an area, each with why and whether its releases are
// followed. One home per project, with org-level entries every project of the org shares. An agent
// reads them first when a design question or a defect has no settled answer in its repo, cites what
// it used, and says what it took or rejected; a followed source's release that touches an open
// problem becomes an idea in the project's Product, and every other release stays on the source's
// timeline and posts nothing. Taught by the cards below, never forced (ISS-1251).

import { z } from "zod";
import type { CapabilityCardBody } from "./capability-cards.js";

export const REFERENCE_KINDS = [
	"repo",
	"product",
	"project",
	"pattern",
	"doc",
] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

/** How an entry came: a person's or an agent's add, or an agent's proposal of a source it kept using. */
export const REFERENCE_ORIGINS = ["added", "proposed"] as const;
export type ReferenceOrigin = (typeof REFERENCE_ORIGINS)[number];

/** What a citing agent did with what it read. */
export const REFERENCE_VERDICTS = ["take", "reject"] as const;
export type ReferenceVerdict = (typeof REFERENCE_VERDICTS)[number];

/** A release read on a followed source either became an idea or stayed silent on the timeline. */
export const REFERENCE_RELEASE_OUTCOMES = ["idea", "silent"] as const;
export type ReferenceReleaseOutcome =
	(typeof REFERENCE_RELEASE_OUTCOMES)[number];

/** Why a source is up for review: archived upstream, no release or push for long, or nobody cites it. */
export const REFERENCE_FLAG_KINDS = [
	"archived",
	"unmaintained",
	"uncited",
] as const;
export type ReferenceFlagKind = (typeof REFERENCE_FLAG_KINDS)[number];

/** What a person decides on a flagged source. */
export const REFERENCE_REVIEW_OPTIONS = ["keep", "replace", "remove"] as const;

/** A source no agent cited for this many days, and older than that, is flagged `uncited`. */
export const REFERENCE_UNCITED_DAYS = 90;
/** A followed repo with no release and no push for this many days is flagged `unmaintained`. */
export const REFERENCE_UNMAINTAINED_DAYS = 180;
/** A newly followed source's first read digests only releases this recent; older ones are history. */
export const REFERENCE_FIRST_READ_DAYS = 14;

export const REFERENCE_LIMITS = {
	title: 120,
	why: 600,
	url: 500,
	area: 60,
	areas: 12,
	ref: 300,
	reason: 600,
	query: 120,
} as const;

const area = z
	.string()
	.trim()
	.toLowerCase()
	.min(1, "an area is a few words naming a module or topic")
	.max(REFERENCE_LIMITS.area);

const url = z
	.url({ protocol: /^https?$/, error: "an http(s) address of the source" })
	.max(REFERENCE_LIMITS.url);

const why = z
	.string()
	.trim()
	.min(3, "why says what this project learns from the source")
	.max(REFERENCE_LIMITS.why);

const entryFields = {
	kind: z.enum(REFERENCE_KINDS),
	url,
	/** The name it is shown under; absent, the repo's `owner/name` or the address's host and path. */
	title: z.string().trim().min(1).max(REFERENCE_LIMITS.title).optional(),
	why,
	areas: z.array(area).min(1).max(REFERENCE_LIMITS.areas),
	/** Lower reads first; absent, after every entry already held. */
	priority: z.number().int().min(1).max(1000).optional(),
	/** Read its new releases and tags; only a github.com repository is followed. */
	followReleases: z.boolean().optional(),
};

/** `POST /api/projects/:id/reference-sources`. `shared` adds it to the project's org, for an org admin. */
export const referenceAddRequestSchema = z.strictObject({
	...entryFields,
	shared: z.boolean().optional(),
});
export type ReferenceAddRequest = z.infer<typeof referenceAddRequestSchema>;
export const REFERENCE_ADD_SHAPE = `{ kind: ${REFERENCE_KINDS.join(" | ")}, url, why, areas: [area, …] (1 to ${REFERENCE_LIMITS.areas}), title?, priority?: 1..1000, followReleases?: boolean (github.com repositories), shared?: boolean (the org's, for an org admin) }`;

/** `POST /api/projects/:id/reference-sources/propose`: an agent's add of a source it kept using. */
export const referenceProposeRequestSchema = z.strictObject({
	...entryFields,
	/** The work it was used on and what was taken: `ISS-12 took its worktree layout`. */
	evidence: z.string().trim().min(3).max(REFERENCE_LIMITS.reason),
});
export type ReferenceProposeRequest = z.infer<
	typeof referenceProposeRequestSchema
>;
export const REFERENCE_PROPOSE_SHAPE = `{ kind: ${REFERENCE_KINDS.join(" | ")}, url, why, areas: [area, …], evidence: the work it helped and what was taken, title?, priority?, followReleases? }`;

/** `PATCH /api/projects/:id/reference-sources/:source`: the fields it changes, at least one. */
export const referenceUpdateRequestSchema = z
	.strictObject({
		kind: entryFields.kind.optional(),
		title: entryFields.title,
		why: why.optional(),
		areas: entryFields.areas.optional(),
		priority: entryFields.priority,
		followReleases: entryFields.followReleases,
	})
	.refine((r) => Object.keys(r).length > 0, {
		message: "name at least one field to change",
	});
export type ReferenceUpdateRequest = z.infer<
	typeof referenceUpdateRequestSchema
>;
export const REFERENCE_UPDATE_SHAPE =
	"{ kind?, title?, why?, areas?, priority?, followReleases? } (at least one)";

/** `POST /api/projects/:id/reference-sources/:source/remove`: kept for history, never served again. */
export const referenceRemoveRequestSchema = z.strictObject({
	reason: z.string().trim().min(3).max(REFERENCE_LIMITS.reason),
});
export const REFERENCE_REMOVE_SHAPE = "{ reason }";

/** `POST /api/projects/:id/reference-sources/:source/citations`: one use of a source. */
export const referenceCiteRequestSchema = z.strictObject({
	/** What was read: a repo path, a doc page, a release tag or its address. */
	ref: z.string().trim().min(1).max(REFERENCE_LIMITS.ref),
	verdict: z.enum(REFERENCE_VERDICTS),
	why: z.string().trim().min(3).max(REFERENCE_LIMITS.reason),
	/** The work it was read for: `ISS-12`, `REQ-3`, `FB-40`. */
	about: z
		.string()
		.trim()
		.regex(
			/^(ISS|REQ|FB)-\d{1,9}$/,
			"the work it was read for: ISS-n, REQ-n or FB-n",
		)
		.optional(),
});
export type ReferenceCiteRequest = z.infer<typeof referenceCiteRequestSchema>;
export const REFERENCE_CITE_SHAPE = `{ ref: the repo path, doc or release read, verdict: ${REFERENCE_VERDICTS.join(" | ")}, why, about?: ISS-n | REQ-n | FB-n }`;

/** `GET /api/projects/:id/reference-sources`: every active source, or those an area or words name. */
export const referenceSearchQuerySchema = z.strictObject({
	area: area.optional(),
	q: z.string().trim().min(1).max(REFERENCE_LIMITS.query).optional(),
});
export type ReferenceSearchQuery = z.infer<typeof referenceSearchQuerySchema>;

export const REFERENCE_REFUSAL_CODES = [
	"REFERENCE_REFUSED",
	"REFERENCE_SOURCE_DUPLICATE",
	"REFERENCE_FOLLOW_UNSUPPORTED",
	"REFERENCE_SHARED_FORBIDDEN",
] as const;
export type ReferenceRefusalCode = (typeof REFERENCE_REFUSAL_CODES)[number];

/** The actions of the MCP door `forge_references` that read; every other one writes. */
export const REFERENCES_TOOL_READS = ["search", "signals", "timeline"] as const;

/** The `owner/name` of a github.com repository address, or null where it names none. */
export function githubRepoOf(address: string): string | null {
	const m =
		/^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#].*)?$/i.exec(
			address.trim(),
		);
	if (!m?.[1] || !m[2]) return null;
	return `${m[1]}/${m[2]}`;
}

/** The feedback key an idea from one release of one source is filed and joined under. */
export const referenceSignalKey = (sourceId: string, tag: string) =>
	`reference-release:${sourceId}:${tag}`;

/** Where an idea a release filed says it was seen. */
export const REFERENCE_FEEDBACK_SCREEN = "reference-sources";

export interface ReferenceSourceView {
	id: string;
	/** `project`: this project's own; `org`: its org's, shared by every project of it. */
	scope: "project" | "org";
	kind: ReferenceKind;
	title: string;
	url: string;
	why: string;
	areas: string[];
	priority: number;
	followReleases: boolean;
	origin: ReferenceOrigin;
	addedBy: string;
	addedAgency: "human" | "agent";
	addedAt: string;
	/** A proposal's evidence: the work it helped. */
	evidence: string | null;
	/** The newest release read from it, and when it was published. */
	lastRelease: { tag: string; at: string | null } | null;
	lastCheckedAt: string | null;
	/** Why the last read of its releases failed, until one succeeds. */
	followError: string | null;
}

export interface ReferenceReleaseView {
	tag: string;
	name: string | null;
	url: string;
	publishedAt: string | null;
	outcome: ReferenceReleaseOutcome;
	/** The open item it may help, `ISS-n` or `REQ-n`, and the words that matched. */
	matched: { ref: string; terms: string[] } | null;
	/** The idea it filed, `FB-n`. */
	idea: string | null;
	readAt: string;
}

export interface ReferenceSourceSignals {
	id: string;
	scope: "project" | "org";
	title: string;
	url: string;
	kind: ReferenceKind;
	areas: string[];
	followReleases: boolean;
	addedAt: string;
	citations: {
		total: number;
		/** In the last REFERENCE_UNCITED_DAYS days. */
		recent: number;
		taken: number;
		rejected: number;
		lastAt: string | null;
	};
	ideas: { filed: number; open: number; taken: number; declined: number };
	lastRelease: { tag: string; at: string | null } | null;
	/** Empty for a source in good standing; otherwise up for keep, replace or remove. */
	flags: { kind: ReferenceFlagKind; detail: string }[];
}

/** `GET /api/projects/:id/reference-sources/signals`. */
export interface ReferenceSignalsResponse {
	sources: ReferenceSourceSignals[];
	window: { uncitedDays: number; unmaintainedDays: number };
	review: typeof REFERENCE_REVIEW_OPTIONS;
}

/**
 * The reference-sources door's capability cards, by MCP action (`forge_references`), and the REST
 * card the orientation's Tier-0 map renders for a master and its runs. Written from the situation
 * ISS-1252 names; the replayable scenarios are owed until one is written. A room agent does these
 * acts through `forge_support`, whose own cards teach it (`core/src/support/reference-cards.ts`):
 * one teaching per act per audience, so none of these is the room agent's.
 */

const FIRST_SITUATION =
	"You face a design question or a defect with no settled answer in this repo";

export const REFERENCE_CARDS = {
	search: {
		purpose:
			"Reads the sources this project learns from first, by area or topic, with their recent releases.",
		situations: [
			{
				when: FIRST_SITUATION,
				do: "read this project's reference sources first (`references.search` by area or topic, plus their recent releases in `references.timeline`); cite repo + file, doc or release with `references.cite`, saying what you take or reject and why",
				watch:
					"researching the open web from zero while the project names the sources it trusts for that area",
			},
			{
				when: "A followed source's release was filed as an idea on the item you work",
				do: "open the release itself, decide take or reject, and record it with `references.cite` naming the release",
			},
		],
		practice: [
			"Search by the area or module you work in first, then by topic words; the project's own entries come before its org's.",
			"Read the source itself (its code, doc or release), never a summary of it, and name the file, doc or release you used.",
			"Say what you take and what you reject, and why, in the citation and in the comment you write.",
		],
		example: {
			action: "search",
			projectId: "<project uuid>",
			area: "harness",
		},
		redFlag:
			"Copying a pattern from a source without citing it, or citing a source you never opened.",
		family: "references",
		audience: ["master", "run"],
		scenarios: [],
	},
	cite: {
		purpose:
			"Records one use of a reference source: what was read, whether it was taken or rejected, and why.",
		situations: [
			{
				when: "You used a reference source in a design, a fix or an answer",
				do: "`references.cite` with the source, the ref (repo path, doc or release), take or reject, why, and the work it was for",
			},
		],
		practice: [
			"One citation per decision, naming the exact file, doc or release.",
			"A reject teaches as much as a take: it tells the next agent why that path was not followed.",
		],
		example: {
			action: "cite",
			projectId: "<project uuid>",
			source: "stablyai/orca",
			ref: "src/worktrees/create.ts",
			verdict: "take",
			why: "one worktree per task under the repo, removed when the task lands",
			about: "ISS-12",
		},
		redFlag:
			"A citation with no reason for its take or reject: it counts as use and teaches nothing.",
		family: "references",
		audience: ["master", "run"],
		scenarios: [],
	},
	add: {
		purpose:
			"Adds a source the project learns from first: why, which areas, and whether its releases are followed.",
		situations: [
			{
				when: 'The owner says to follow or learn from a repo, product or doc for some area ("follow X for Y")',
				do: "`references.add` with its address, why in his words, the areas, and followReleases where it ships releases; then tell him it is added",
				watch: "sending him to a screen to add it himself",
			},
		],
		practice: [
			"Write why as what this project learns from it, in the owner's words where he gave them.",
			"Areas are the modules or topics it informs, so a search by area finds it.",
		],
		example: {
			action: "add",
			projectId: "<project uuid>",
			kind: "repo",
			url: "https://github.com/stablyai/orca",
			why: "parallel CLI agents in isolated git worktrees",
			areas: ["parallel agents", "worktrees"],
			followReleases: true,
		},
		family: "references",
		audience: ["master", "run", "person"],
		scenarios: [],
	},
	propose: {
		purpose:
			"Adds a source an agent keeps finding useful, recorded as the agent's proposal with its evidence.",
		situations: [
			{
				when: "You have used the same outside source on several pieces of work and the project does not list it",
				do: "`references.propose` with its address, why, areas and the evidence: the work it helped and what you took",
			},
		],
		practice: [
			"Name the work it helped as evidence, by key, and what you took from it.",
		],
		redFlag:
			"Proposing every page read once; a source earns its place by repeated use.",
		family: "references",
		audience: ["master", "run"],
		scenarios: [],
	},
} satisfies Record<string, CapabilityCardBody>;

/** The REST door's card, for the orientation's Tier-0 map of a master and its runs. */
export const REFERENCE_REST_CARD = {
	purpose: REFERENCE_CARDS.search.purpose,
	situations: [
		{
			when: FIRST_SITUATION,
			do: "read the project's reference sources first: `projects/<id>/reference-sources?area=<area>` (or `q=<words>`) and a source's `…/<source>/timeline`; cite what you used with `…/<source>/citations -X POST` (ref, take or reject, why)",
			watch:
				"researching from zero while the project names sources it trusts for that area",
		},
	],
	practice: [...REFERENCE_CARDS.search.practice],
	example: {
		ref: "https://docs.stripe.com/payments/checkout#reorder",
		verdict: "take",
		why: "Its reorder flow keeps the original line prices, as REQ-12 asks.",
		about: "REQ-12",
	},
	redFlag: REFERENCE_CARDS.search.redFlag,
	family: "references",
	audience: ["master", "run"],
	scenarios: [],
} satisfies CapabilityCardBody;
