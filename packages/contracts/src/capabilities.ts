// What the capabilities page reads beside a project's door use (ISS-1251 §7): the reports its agents
// filed on a door (`door-use.ts:DOOR_REPORT_VERDICTS`) and the lessons anchored to a door's card. The
// use itself, the piles and the card are door-use's own reads; this answers only what they leave out.

import { z } from "zod";
import { DOOR_USE_DAYS, type DoorReportVerdict } from "./door-use.js";
import type { LessonStatus } from "./lessons.js";

export const capabilitiesQuerySchema = z.strictObject({
	days: z.coerce
		.number()
		.int()
		.min(DOOR_USE_DAYS.min)
		.max(DOOR_USE_DAYS.max)
		.default(DOOR_USE_DAYS.default),
	/**
	 * A module, by slug or path (ISS-1256): the read narrowed to the cards of that module's subtree,
	 * the module map's Capabilities branch. Absent, every card.
	 */
	module: z.string().trim().min(1).max(128).optional(),
});
export type CapabilitiesQuery = z.infer<typeof capabilitiesQuerySchema>;

/** The reports this project's agents filed on one door in the window, by verdict. */
export interface CapabilityFeedbackRow {
	/** The door as filed: a card id, a REST template, or teaching (`guide:<slug>`); a `missing` report naming none keys by its words. */
	door: string;
	reports: number;
	byVerdict: Partial<Record<DoorReportVerdict, number>>;
	lastAt: string;
}

/** One live lesson anchored to a card (`card:<id>`). */
export interface CapabilityLessonRow {
	/** The card id the anchor names. */
	card: string;
	number: number;
	sentence: string;
	status: Extract<LessonStatus, "proposed" | "approved" | "held">;
	/** A landing touched its anchor: kept for history, served to no agent until re-checked. */
	invalid: boolean;
	invalidBy: string | null;
	applied: number;
	lastAppliedAt: string | null;
}

/** How fresh a card is: a re-check a landing owes it, its scenarios' last replays, and lessons folded into it not yet in its code. */
export interface CapabilityFreshnessRow {
	card: string;
	/** Since a landing touched its door or a lesson on it, until the steward re-checks it. */
	recheckOwed: { since: string } | null;
	/**
	 * The last replay of each of its scenarios: the change it was replayed for (the card's change as
	 * served, a lesson's fold or edit) and why it held or failed.
	 */
	scenarios: { name: string; passed: boolean; at: string; change: string; reason: string }[];
	/** The deltas this project's lessons folded into it that its code does not carry yet. */
	proposed: { field: "situation" | "bestPractice" | "redFlag"; text: string }[];
}

/**
 * The steps the steward's lessons pass takes on a project, in order (`steward/lessons-pass.ts`):
 * gather what waits, group corrections, settle proposals and confusions, anchor, re-check the
 * invalidated, apply carried card deltas, fold, retire, file checks, read the piles, record the month.
 */
export const LESSONS_PASS_STEPS = [
	"gather",
	"group",
	"settle",
	"anchor",
	"recheck",
	"card-deltas",
	"fold",
	"retire",
	"checks",
	"piles",
	"months",
] as const;
export type LessonsPassStep = (typeof LESSONS_PASS_STEPS)[number];

/** The model judges a lessons pass asks; each may give no answer, which leaves its item where it was. */
export const LESSONS_PASS_JUDGES = [
	"group",
	"review",
	"settle",
	"classify",
	"anchor",
	"recheck",
	"fold",
	"replay",
	"merge",
] as const;
export type LessonsPassJudge = (typeof LESSONS_PASS_JUDGES)[number];

/**
 * The last lessons pass the steward ran on this project (ISS-1251 round 6): when, what it moved and
 * left waiting, the step it stopped at, and each judge that gave no answer. A pass that fails or moves
 * nothing says so here, not only in core's log.
 */
export interface LessonsPassReport {
	startedAt: string;
	endedAt: string;
	/** The step the pass failed at and the error it failed on; null where it ran every step. */
	stopped: { step: LessonsPassStep; error: string } | null;
	/** This project's tally, by the pass's own names (`settled`, `readmitted`, `waiting`, …). */
	tally: Record<string, number>;
	/**
	 * Each judge that gave no answer this pass: how many times, and the last reason its model call
	 * gave (`unconfigured`, `withheld`, `failed`, `unreadable`) with its detail, null where none was said.
	 */
	unanswered: { judge: LessonsPassJudge; count: number; miss: string | null; detail: string | null }[];
}

export interface CapabilitiesView {
	projectId: string;
	window: { days: number; since: string; until: string };
	feedback: CapabilityFeedbackRow[];
	lessons: CapabilityLessonRow[];
	/** Only the cards with something to say: a re-check owed, a scenario replayed or a delta proposed. */
	freshness: CapabilityFreshnessRow[];
	/**
	 * The module asked (ISS-1256), by path, and the card ids it holds, which every list above is
	 * narrowed to; null where no module was asked.
	 */
	module: { path: string; cards: string[] } | null;
	/** The steward's last lessons pass on this project; null where none has run since passes were kept. */
	lessonsPass: LessonsPassReport | null;
	/** What these reads cannot tell, so a gap is never read as "nobody did it". */
	limits: string[];
}
