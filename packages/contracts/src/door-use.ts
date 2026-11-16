// What agents do with the doors Forge gives them (ISS-1251): how often each door was called, per
// project and per agent kind, with the doors nobody called listed beside the ones in use; what each
// agent kind read (knowledge, lessons, memory, rules) and applied; and the report an agent files when
// a door or a piece of teaching failed it, which becomes feedback on the feature that owns it.

import { z } from "zod";
import type { CapabilityCard, CardAudience } from "./capability-cards.js";
import type { FeedbackKind } from "./feedback-terms.js";
import { forgeFeedbackFromSchema } from "./forge-feedback.js";
import type { RefusalStatuses } from "./refusal.js";
import type { RunContextHow, RunContextSourceKind } from "./run-context.js";

/** The window a use read covers, in days back from now. */
export const DOOR_USE_DAYS = { min: 1, max: 90, default: 30 } as const;

/**
 * Where a door is served: an MCP action (`<door>.<action>`, as `forge_find` lists it) or a REST
 * route (`METHOD /api/...`, as the published API contract lists it). Only a REST write is logged,
 * so a REST read is no door here; what a read returned is counted under `reads` instead.
 */
export const DOOR_SURFACES = ["mcp", "rest"] as const;
export type DoorSurface = (typeof DOOR_SURFACES)[number];

export const doorUseQuerySchema = z.strictObject({
	days: z.coerce
		.number()
		.int()
		.min(DOOR_USE_DAYS.min)
		.max(DOOR_USE_DAYS.max)
		.default(DOOR_USE_DAYS.default),
	surface: z.enum(DOOR_SURFACES).optional(),
	/** `never`: only the doors no agent called in the window. */
	used: z.enum(["never", "used"]).optional(),
});
export type DoorUseQuery = z.infer<typeof doorUseQuerySchema>;

/**
 * Who called, read off the credential it called with: a room's agent (`room:<room kind>`), another
 * session on a box (`session:<session kind>`), a box itself (`box`: its master and the runs it
 * starts share its credential), a checkout's credential (`checkout`), the in-process assistant, the
 * steward, an MCP client signed in by OAuth, a sandbox script, an agent account's own token, or a
 * person's token.
 */
export type DoorAgentKind = string;

/** One door and how often it was called in the window. */
export interface DoorUseRow {
	/** `<door>.<action>` for MCP, `METHOD /path` (the contract's template) for REST. */
	door: string;
	surface: DoorSurface;
	/** One line: what the door is for, as its own guide says it (MCP), or null (REST). */
	summary: string | null;
	/** The feature that owns it: the MCP tool and its REST twin, or the route's first segments. */
	feature: string;
	/** Its capability card: what teaches an agent when to reach for it; null where none is written. */
	card: CapabilityCard | null;
	/**
	 * Per audience its card teaches: 0 where that audience's Tier-0 map carries it (every turn), 1 where
	 * it is reached by situation through forge_find; empty without a card.
	 */
	tiers: Partial<Record<CardAudience, 0 | 1>>;
	calls: number;
	/** Calls that did not end `ok`, and a room act's refusals its room recorded. */
	refused: number;
	/** `refused` by code: the log's result code (forbidden, not_found, error) or a room act's refusal code. */
	refusedBy: Record<string, number>;
	/** Calls by agent kind; a kind that made none is absent. */
	byAgent: Record<DoorAgentKind, number>;
	lastAt: string | null;
}

/** What one agent kind read in the window, by source kind and how it reached it. */
export interface DoorReadRow {
	agent: DoorAgentKind;
	kind: RunContextSourceKind;
	how: RunContextHow;
	reaches: number;
	/** How many distinct entries (slugs, memory ids). */
	entries: number;
	/** The most-read entries, most first, at most `DOOR_USE_TOP`. */
	top: { ref: string; reaches: number }[];
}

/** One approved lesson an agent said it applied, by agent kind. */
export interface DoorLessonAppliedRow {
	lesson: string;
	agent: DoorAgentKind;
	applications: number;
}

export const DOOR_USE_TOP = 5;

/** One UTC day of the window: every logged call of the project that day, and those not `ok`. */
export interface DoorUseDay {
	/** `YYYY-MM-DD`. */
	day: string;
	calls: number;
	refused: number;
}

export interface DoorUseView {
	projectId: string;
	window: { days: number; since: string; until: string };
	/** Every door of the catalog (filtered by the query), the never-called ones included, most called first. */
	doors: DoorUseRow[];
	/** The catalog's size, and how many of its doors no agent called in the window. */
	totals: { doors: number; neverUsed: number; calls: number; taught: number };
	/** Every day of the window, a day with no call included. */
	days: DoorUseDay[];
	/** Logged calls that name no door of the catalog (a retired tool, a route since removed), by name. */
	unmatched: { door: string; calls: number }[];
	reads: DoorReadRow[];
	lessonsApplied: DoorLessonAppliedRow[];
	/** What the logs cannot tell, so a gap is never read as "nobody did it". */
	limits: string[];
}

/**
 * What an agent says about a door or a piece of teaching (ISS-1251): it did not do what the agent
 * needed, the teaching did not say when or how to use it, or no door does what it needed.
 */
export const DOOR_REPORT_VERDICTS = [
	"did_not_help",
	"unclear",
	"missing",
] as const;
export type DoorReportVerdict = (typeof DOOR_REPORT_VERDICTS)[number];

/** The feedback kind each verdict files as. */
export const DOOR_REPORT_KIND: Record<DoorReportVerdict, FeedbackKind> = {
	did_not_help: "bug",
	unclear: "change_request",
	missing: "idea",
};

/**
 * The teaching an agent reads, named by kind and its own key: a served guide, a lesson, a knowledge
 * entry, a skill, or a line of a brief or prompt (named by where it is read: `brief:room support`).
 */
export const DOOR_TEACHING_KINDS = [
	"guide",
	"lesson",
	"knowledge",
	"skill",
	"brief",
] as const;
export type DoorTeachingKind = (typeof DOOR_TEACHING_KINDS)[number];

export const DOOR_REF_SHAPE =
	"an MCP action as forge_find lists it (`support.member`), a REST route (`POST /api/projects/:id/feedback`), or teaching as `<guide|lesson|knowledge|skill|brief>:<its key>` (`guide:agent-setup`, `lesson:103`, `brief:room support`)";

export const doorReportRequestSchema = z.strictObject({
	/** The door or teaching it is about; for `missing`, the nearest door, or absent. */
	door: z.string().trim().min(3).max(300).optional(),
	verdict: z.enum(DOOR_REPORT_VERDICTS),
	/** What you were doing, what you reached for, and what it did or lacked. */
	what: z.string().trim().min(10).max(4_000),
	from: forgeFeedbackFromSchema.optional(),
});
export type DoorReportRequest = z.infer<typeof doorReportRequestSchema>;

export const DOOR_REPORT_SHAPE = `{ verdict: ${DOOR_REPORT_VERDICTS.join(" | ")}, door: ${DOOR_REF_SHAPE} (for missing: the nearest door, or leave it out), what: what you were doing and what it did or lacked, from?: { project?, issue?, run? } }`;

export const DOOR_REPORT_REFUSAL_CODES = [
	"DOOR_REPORT_UNKNOWN_DOOR",
	"DOOR_REPORT_DOOR_REQUIRED",
] as const;
export type DoorReportRefusalCode = (typeof DOOR_REPORT_REFUSAL_CODES)[number];

export const DOOR_REPORT_REFUSAL_STATUSES = {
	DOOR_REPORT_UNKNOWN_DOOR: 400,
	DOOR_REPORT_DOOR_REQUIRED: 400,
} as const satisfies RefusalStatuses<DoorReportRefusalCode>;

/**
 * The most characters a skill's always-on part (its description, which every session loads to
 * decide whether to open the skill) takes: the limit Claude Code's skill loader holds it to.
 */
export const SKILL_ALWAYS_ON_MAX_CHARS = 1024;

/** The learned and taught texts every prompt carries, each under its own cap (ISS-1251). */
export const PILES = [
	"always_knowledge",
	"lessons_map",
	"skill_always_on",
	"tier0_map",
] as const;
export type Pile = (typeof PILES)[number];

/**
 * One pile's size against its cap. A pile at its cap is consolidated (its items folded into the
 * teaching that owns them, or retired), never cut: `over` says it is due.
 */
export interface PileRow {
	pile: Pile;
	/** The pile's own name: `always-on knowledge`, `lessons map (runs)`, `map (bot)`, or the skill's name. */
	name: string;
	/** Characters it takes in every prompt that carries it. */
	size: number;
	cap: number;
	/** How many items it holds, and how many of them the prompt carries (the map names only as many as fit). */
	items: number;
	carried: number;
	over: boolean;
}

export interface PilesView {
	projectId: string;
	piles: PileRow[];
}
