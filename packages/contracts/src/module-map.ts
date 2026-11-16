// The module map (ISS-1256, owner 2026-11-16): every business module is a pillar, and what Forge
// knows hangs under one: its terms (knowledge `glossary`), rules (knowledge `rule`), capabilities
// (ISS-1251 cards, placed by the code module that owns their door), requirements and their
// behaviours, decisions and reference sources (ISS-1252); issues, lessons and other knowledge carry a
// module too. A module is a FIELD on each record, written by an agent through the placement door, and
// the records are linked by exactly five relation kinds. Core infers none of it: no module from
// touched files, no tag, no gate refusing an unplaced item. The pillar and the tree are reads of what
// agents wrote; an unplaced item is a gap shown, never refused.

import { z } from "zod";

/** The branches of a module's tree, in the order the pillar's columns and the tree read them. */
export const MODULE_MAP_BRANCHES = [
	"term",
	"rule",
	"capability",
	"requirement",
	"decision",
	"reference",
] as const;
export type ModuleMapBranch = (typeof MODULE_MAP_BRANCHES)[number];

/** What a relation's end can be: a branch's record, a module, or a code anchor (`file.ts:symbol`). */
export const MODULE_MAP_NODE_TYPES = [
	...MODULE_MAP_BRANCHES,
	"module",
	"code",
] as const;
export type ModuleMapNodeType = (typeof MODULE_MAP_NODE_TYPES)[number];

/**
 * What the placement door sets the module of, and how each is named in `ref`:
 * term, rule, knowledge — the entry's slug (a term is a `glossary` entry, a rule a `rule` one);
 * requirement — `REQ-<n>`; decision — the decision comment's id; reference — the source's id;
 * issue — `ISS-<n>` or its id; lesson — `L-<n>`. A capability is placed by the code module its
 * door lives in (its card's owner), never by this door.
 */
export const MODULE_MAP_PLACEABLE_TYPES = [
	"term",
	"rule",
	"knowledge",
	"requirement",
	"decision",
	"reference",
	"issue",
	"lesson",
] as const;
export type ModuleMapPlaceableType =
	(typeof MODULE_MAP_PLACEABLE_TYPES)[number];

/** The five relation kinds; there is no generic "related" kind. */
export const MODULE_RELATION_KINDS = [
	"belongs_to",
	"used_in",
	"governs",
	"from",
	"anchored_at",
] as const;
export type ModuleRelationKind = (typeof MODULE_RELATION_KINDS)[number];

/**
 * Which ends each kind joins. `belongs_to` is the record's module field, written by the placement
 * door; the other four are stored relations, each starting at a term or a rule.
 */
export const MODULE_RELATION_ENDS = {
	belongs_to: { from: MODULE_MAP_PLACEABLE_TYPES, to: ["module"] },
	used_in: { from: ["term"], to: ["rule", "capability"] },
	governs: { from: ["rule"], to: ["capability"] },
	from: { from: ["term", "rule"], to: ["requirement", "decision"] },
	anchored_at: { from: ["term", "rule"], to: ["code"] },
} as const satisfies Record<
	ModuleRelationKind,
	{
		from: readonly (ModuleMapNodeType | ModuleMapPlaceableType)[];
		to: readonly ModuleMapNodeType[];
	}
>;

/** The relation kinds stored as rows (every kind but the module field). */
export const MODULE_STORED_RELATION_KINDS = [
	"used_in",
	"governs",
	"from",
	"anchored_at",
] as const satisfies readonly ModuleRelationKind[];
export type ModuleStoredRelationKind =
	(typeof MODULE_STORED_RELATION_KINDS)[number];

/** A code anchor: a repository path to a source file, a colon, and the symbol in it. */
export const CODE_ANCHOR_PATTERN =
	/^[A-Za-z0-9_.@-]+(\/[A-Za-z0-9_.@-]+)*\.(ts|tsx|mts|mjs|cjs|js|jsx|rs|sql|sh|py|go):[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
export const CODE_ANCHOR_SHAPE =
	"`<path>/<file>.<ext>:<symbol>`, e.g. `packages/core/src/devices/run-slots.ts:slotsFor`";

/** A requirement or one of its behaviours: `REQ-12` or `REQ-12 BC-3`. */
export const REQUIREMENT_REF_PATTERN = /^REQ-[1-9]\d*( BC-[1-9]\d*)?$/;

const alias = z.string().trim().min(1).max(120);
const aliasList = z.array(alias).min(1).max(8);

/**
 * A term's other names: Vietnamese, the name in code, and the industry's name
 * (run slots = chia slot = fair-share scheduling). At least one list is sent.
 */
export const termAliasesSchema = z
	.strictObject({
		vi: aliasList.optional(),
		code: aliasList.optional(),
		industry: aliasList.optional(),
	})
	.refine((a) => a.vi || a.code || a.industry, {
		message: "send at least one of vi, code, industry",
	});
export type TermAliases = z.infer<typeof termAliasesSchema>;

/** Who named the thing, in their own words: the term's provenance. */
export const termNamedBySchema = z.strictObject({
	who: z.string().trim().min(1).max(120),
	quote: z.string().trim().min(1).max(600),
});
export type TermNamedBy = z.infer<typeof termNamedBySchema>;

/**
 * What a `glossary` entry carries beyond its text, stored as `knowledge_entries.term`; any other
 * kind carrying it is refused `MODULE_MAP_TERM_NOT_GLOSSARY`.
 */
export const termFieldsSchema = z
	.strictObject({
		aliases: termAliasesSchema.optional(),
		namedBy: termNamedBySchema.optional(),
	})
	.refine((t) => t.aliases || t.namedBy, {
		message: "send aliases, namedBy or both",
	});
export type TermFields = z.infer<typeof termFieldsSchema>;

/** One end of a relation, named as `MODULE_MAP_PLACEABLE_TYPES` says, a module by its slug, code by its anchor. */
export const moduleMapNodeRefSchema = z.strictObject({
	type: z.string().trim().min(1).max(40),
	ref: z.string().trim().min(1).max(512),
});
export type ModuleMapNodeRef = { type: ModuleMapNodeType; ref: string };

/**
 * A relation write. `kind` is read by name and a kind outside the five is refused
 * `MODULE_MAP_RELATION_KIND_UNKNOWN`; an end of a type the kind does not join,
 * `MODULE_MAP_RELATION_ENDS`.
 */
export const moduleRelationWriteSchema = z.strictObject({
	kind: z.string().trim().min(1).max(40),
	from: moduleMapNodeRefSchema,
	to: moduleMapNodeRefSchema,
});
export type ModuleRelationWrite = z.infer<typeof moduleRelationWriteSchema>;

/** A placement: the record and the module it belongs to, by slug; `null` takes it out of every module. */
export const modulePlacementSchema = z.strictObject({
	type: z.string().trim().min(1).max(40),
	ref: z.string().trim().min(1).max(512),
	module: z.string().trim().min(1).max(128).nullable(),
});
export type ModulePlacementWrite = z.infer<typeof modulePlacementSchema>;

export const MODULE_MAP_REFUSAL_CODES = [
	"MODULE_MAP_REFUSED",
	"MODULE_MAP_MODULE_UNKNOWN",
	"MODULE_MAP_TYPE_UNKNOWN",
	"MODULE_MAP_NODE_NOT_FOUND",
	"MODULE_MAP_RELATION_KIND_UNKNOWN",
	"MODULE_MAP_RELATION_ENDS",
	"MODULE_MAP_ANCHOR_SHAPE",
	"MODULE_MAP_TERM_NOT_GLOSSARY",
	"MODULE_MAP_KIND_MISMATCH",
	"MODULE_MAP_ORG_REFERENCE",
] as const;
export type ModuleMapRefusalCode = (typeof MODULE_MAP_REFUSAL_CODES)[number];

/** The read actions of `forge_module`; every other action writes. */
export const MODULE_TOOL_READS = ["get", "pillar"] as const;

/** The window agents' reads of a node are counted over. */
export const MODULE_MAP_READS_WINDOW_DAYS = 30;
/** At most this many unplaced items per type are listed; `total` counts them all. */
export const MODULE_MAP_UNPLACED_SHOWN = 50;
/** The most characters the module lines of a Tier-0 map take. */
export const TIER0_MODULE_LINES_MAX_CHARS = 1500;

// ---------------------------------------------------------------- reads

/** A module as the map names it. `path` is its slug path from the root (`execution/devices`). */
export interface ModuleMapModuleRef {
	id: string;
	slug: string;
	name: string;
	path: string;
}

/** A count per branch, plus what only carries a module. */
export type ModuleMapCounts = Record<ModuleMapBranch, number> & {
	knowledge: number;
	lesson: number;
};

/**
 * One row of the pillar: a business module (a root module label) with its counts over its whole
 * subtree, and its open issues, the only health figure (no score).
 */
export interface ModulePillarRow {
	module: ModuleMapModuleRef;
	description: string | null;
	counts: ModuleMapCounts;
	openIssues: number;
}

/** One item placed in no module, as the Unplaced row lists it. */
export interface ModuleUnplacedItem {
	type: ModuleMapBranch | "knowledge" | "lesson" | "issue";
	ref: string;
	title: string;
}

/** The Unplaced row: counts like a module's, and the items, at most `MODULE_MAP_UNPLACED_SHOWN` per type. */
export interface ModuleUnplacedRow {
	counts: ModuleMapCounts;
	openIssues: number;
	items: ModuleUnplacedItem[];
}

/** GET /api/projects/:id/modules/map — the pillar. */
export interface ModulePillarResponse {
	generatedAt: string;
	branches: readonly ModuleMapBranch[];
	modules: ModulePillarRow[];
	unplaced: ModuleUnplacedRow;
}

/** A relation as a node shows it: its kind, which way it points from the node, and the other end. */
export interface ModuleMapRelationView {
	/** The stored relation's id; null for `belongs_to`, which is the module field. */
	id: string | null;
	kind: ModuleRelationKind;
	direction: "out" | "in";
	other: {
		type: ModuleMapNodeType;
		ref: string;
		/** The other end's title; null where it no longer resolves (a code anchor has none). */
		title: string | null;
		/** The other end's module path; null where it has none. */
		module: string | null;
	};
	writtenBy: { name: string | null; agency: "human" | "agent" } | null;
	at: string | null;
}

/** A node's re-check: owed since a landing changed what it is anchored at, else null. */
export interface ModuleMapRecheck {
	since: string;
	by: string;
	matched: string[];
}

/** One node of a module's tree. */
export interface ModuleMapNode {
	type: ModuleMapBranch;
	ref: string;
	title: string;
	/** One line of its text; null where it carries none. */
	summary: string | null;
	/** The module it is placed in, which may be a child of the module read. */
	module: string;
	/** A requirement's or a decision's status, a rule's `active`/`deprecated`; null where none applies. */
	status: string | null;
	/** A term's other names; absent on every other type. */
	aliases?: TermAliases;
	/** A term's provenance, quoting who named it; absent where none was written. */
	namedBy?: TermNamedBy;
	/** Who wrote it into Forge: a person or an agent. Null where the record does not keep it. */
	writtenBy: { agency: "human" | "agent" | "imported" } | null;
	relations: ModuleMapRelationView[];
	recheck: ModuleMapRecheck | null;
	/**
	 * How often agents read it over `readsWindowDays`, from ISS-1251's signals: a term's or a rule's
	 * reaches (run_context_reaches), a capability's door calls, a reference's citations. Null where
	 * Forge keeps no read signal for the type (a requirement, a decision).
	 */
	reads: number | null;
}

/** An open issue in the module's subtree. */
export interface ModuleMapInFlight {
	key: string;
	title: string;
	status: string;
	module: string;
}

/** GET /api/projects/:id/modules/:module/map (and `module.get`) — one module's tree, Tier 1. */
export interface ModuleTreeResponse {
	module: ModuleMapModuleRef & {
		description: string | null;
		parent: ModuleMapModuleRef | null;
		children: ModuleMapModuleRef[];
	};
	branches: Record<ModuleMapBranch, ModuleMapNode[]>;
	inFlight: ModuleMapInFlight[];
	openIssues: number;
	readsWindowDays: number;
	generatedAt: string;
}

/** A placement's answer: the record, the module it is in now (null where taken out) and the one before. */
export interface ModulePlacementResult {
	type: ModuleMapPlaceableType;
	ref: string;
	module: string | null;
	previous: string | null;
}

/** A relation write's answer. */
export interface ModuleRelationResult {
	id: string;
	kind: ModuleStoredRelationKind;
	from: ModuleMapNodeRef;
	to: ModuleMapNodeRef;
	/** Whether this write made it; false where the same relation stood already. */
	created: boolean;
}

/** One module's line on a Tier-0 map. */
export interface ModuleMapLine {
	slug: string;
	name: string;
	description: string | null;
	terms: number;
	rules: number;
	openIssues: number;
}
