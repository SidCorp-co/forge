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
	/** The last replay of each of its scenarios. */
	scenarios: { name: string; passed: boolean; at: string }[];
	/** The deltas this project's lessons folded into it that its code does not carry yet. */
	proposed: { field: "situation" | "bestPractice" | "redFlag"; text: string }[];
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
	/** What these reads cannot tell, so a gap is never read as "nobody did it". */
	limits: string[];
}
