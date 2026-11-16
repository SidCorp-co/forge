// The one search door (ISS-1256): one index over every record type, the same ranks for a person's
// Cmd-K, an agent's `forge_find` and the REST find. Keyword and vector arms are fused by reciprocal
// rank; the query expands through the glossary's aliases; hits come grouped by type with facets by
// type, module and status, each carrying its tree path and the handle that opens it.

import { z } from "zod";
import type { ModuleStoredRelationKind } from "./module-map.js";

/** Every record type the door finds, in the order its groups answer. */
export const FIND_TYPES = [
	"term",
	"rule",
	"capability",
	"requirement",
	"decision",
	"reference",
	"issue",
	"feedback",
	"lesson",
	"knowledge",
	"memory",
	"conversation",
] as const;
export type FindType = (typeof FIND_TYPES)[number];

/** A type as its group and its tree path name it. */
export const FIND_TYPE_LABELS: Record<FindType, string> = {
	term: "Terms",
	rule: "Rules",
	capability: "Capabilities",
	requirement: "Requirements",
	decision: "Decisions",
	reference: "References",
	issue: "Issues",
	feedback: "Feedback",
	lesson: "Lessons",
	knowledge: "Knowledge",
	memory: "Memory",
	conversation: "Conversations",
};

/** The path's first step for a hit no module holds; the pillar's Unplaced row. */
export const FIND_UNPLACED = "Unplaced";

/** How a hit was found: a keyword arm, a vector arm, or a glossary alias the query named. */
export const FIND_MATCH_ARMS = ["keyword", "semantic", "alias"] as const;
export type FindMatchArm = (typeof FIND_MATCH_ARMS)[number];

export const FIND_QUERY_MAX = 200;
export const FIND_LIMIT = { default: 20, max: 50 } as const;

/** A comma list (`term,rule`) or a repeated parameter, as one list of the allowed values. */
const listOf = <T extends string>(values: readonly [T, ...T[]]) =>
	z
		.union([z.string(), z.array(z.string())])
		.transform((v) =>
			(Array.isArray(v) ? v : v.split(","))
				.map((s) => s.trim())
				.filter(Boolean),
		)
		.pipe(z.array(z.enum(values)).max(values.length));

const freeList = z
	.union([z.string(), z.array(z.string())])
	.transform((v) =>
		(Array.isArray(v) ? v : v.split(",")).map((s) => s.trim()).filter(Boolean),
	)
	.pipe(z.array(z.string().min(1).max(80)).max(20));

/**
 * A find, as `POST /api/projects/:id/find` takes it in its body and `forge_find` in its arguments.
 * `module` takes module slugs, or `unplaced` for hits no module holds; `status` takes the statuses
 * the facets answer. `conversation` searches one room's transcript, which its own fence decides.
 */
export const findQuerySchema = z.strictObject({
	q: z.string().trim().min(1).max(FIND_QUERY_MAX),
	type: listOf(FIND_TYPES).optional(),
	module: freeList.optional(),
	status: freeList.optional(),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(FIND_LIMIT.max)
		.default(FIND_LIMIT.default),
	conversation: z.uuid().optional(),
});
export type FindQuery = z.infer<typeof findQuerySchema>;

/** The module filter's value for hits no module holds. */
export const FIND_UNPLACED_FILTER = "unplaced";

/**
 * The module a hit is placed in: `slug` and `name` are its business module (the root of its module
 * labels, the pillar's row and the module facet), `path` the slug path to the label it is placed
 * under (`execution/devices`).
 */
export interface FindHitModule {
	slug: string;
	name: string;
	path: string;
}

/** One hit, the same for a person and an agent. */
export interface FindHit {
	/** `<type>:<ref>`: the handle `find/open` and MCP `fetch` take. */
	id: string;
	type: FindType;
	/** The record's own id: a uuid, a knowledge slug, a card id. */
	ref: string;
	/** How a person names it (ISS-12, REQ-3, FB-4, a slug, a card id); null where it has none. */
	key: string | null;
	title: string;
	/** At most 280 characters of its text. */
	excerpt: string;
	/** The project it belongs to; null for what every project shares (a card, an org ruling). */
	projectSlug: string | null;
	module: FindHitModule | null;
	/** What the status facet counts it under; null where its type has no status. */
	status: string | null;
	/** Its place in the module tree: `[business module name or Unplaced, type label]`. */
	path: [string, string];
	/** Which arms found it, and the alias that matched where the glossary expanded the query. */
	match: { arms: FindMatchArm[]; alias: string | null };
	/** The fused reciprocal-rank score; read the order, never the value. */
	score: number;
	/** The REST path that opens it with its relations and records the read. */
	open: string;
}

export interface FindGroup {
	type: FindType;
	label: string;
	hits: FindHit[];
}

export interface FindFacet {
	value: string;
	label: string;
	count: number;
}

/** A glossary term the query named by one of its aliases, and what it added to the query. */
export interface FindExpansion {
	term: string;
	alias: string;
	termId: string;
}

export interface FindResult {
	query: string;
	expanded: FindExpansion[];
	/** Hits by type, each group where its best hit ranks, its hits best first; a type with none is left out. */
	groups: FindGroup[];
	/** Counted over every hit before the type, module and status filters. */
	facets: { type: FindFacet[]; module: FindFacet[]; status: FindFacet[] };
	/** Hits answered, over the groups. */
	total: number;
	/** The vector arms did not run (no embeddings), so ranks are keyword only. */
	degraded: boolean;
	/** True when nothing matched, and the miss was recorded as a gap. */
	gap: boolean;
}

/**
 * One relation of an opened term or rule (`contracts/module-map.ts`): which way it points from the
 * hit, and the other end as its type and ref (a slug, `REQ-12 BC-3`, a card id, `file.ts:symbol`).
 */
export interface FindRelation {
	kind: ModuleStoredRelationKind;
	direction: "out" | "in";
	type: string;
	ref: string;
}

/** One opened hit: where a person reads it, and what it is linked to. */
export interface FindOpened {
	hit: FindHit;
	/** The web path that shows the record. */
	url: string;
	/** Its text, as far as this door serves it. */
	text: string;
	/** A term's or a rule's relations, each walkable by a find of its ref; empty for any other type. */
	relations: FindRelation[];
}

export const findOpenQuerySchema = z.strictObject({
	id: z.string().min(3).max(200),
});

/** A query that found nothing, as many times as it was asked in the window. */
export interface FindGap {
	query: string;
	searches: number;
	firstAt: string;
	lastAt: string;
	/** Who asked last: `person`, `agent`, or a session kind. */
	lastBy: string;
}

export const FIND_GAPS_DAYS = { min: 1, max: 90, default: 30 } as const;

export const findGapsQuerySchema = z.strictObject({
	days: z.coerce
		.number()
		.int()
		.min(FIND_GAPS_DAYS.min)
		.max(FIND_GAPS_DAYS.max)
		.default(FIND_GAPS_DAYS.default),
});

export interface FindGapsView {
	projectId: string;
	window: { days: number; since: string };
	gaps: FindGap[];
}

/** Why a find or an open was refused. */
export const FIND_REFUSAL_CODES = [
	"FIND_HIT_ID_INVALID",
	"FIND_HIT_NOT_FOUND",
] as const;
export type FindRefusalCode = (typeof FIND_REFUSAL_CODES)[number];
