// The one place a requirement's stage, roadmap horizon, one-line wait and failing count are derived
// (REQ-29 BC-6 to BC-9). The Requirements list, its map and the status report's roadmap all read
// these, so a requirement is never in one stage on one screen and another on the next.

import type { RequirementState } from "./requirements.js";

export const REQUIREMENT_STAGES = [
	"draft",
	"agreed",
	"build",
	"decide",
	"prove",
	"check",
	"done",
	"deferred",
] as const;
export type RequirementStage = (typeof REQUIREMENT_STAGES)[number];

export const REQUIREMENT_STAGE_LABELS: Record<RequirementStage, string> = {
	draft: "Draft",
	agreed: "Agreed",
	build: "Building",
	decide: "Needs a decision",
	prove: "Proving",
	check: "Your check",
	done: "Accepted",
	deferred: "Deferred",
};

export const ROADMAP_HORIZONS = ["now", "next", "later"] as const;
export type RoadmapHorizon = (typeof ROADMAP_HORIZONS)[number];

/** The slice of a requirement's standing the rules read. */
export interface StageInput {
	state: RequirementState;
	attentionGroup: string;
	waitingOn: { who: string; act: string; says: { who: { key: string } } };
	facts: { passing: number; judged: number; criteria: number };
}

/** Where a requirement stands. `null` for a dropped or refused one, which is on no roadmap. */
export function requirementStageOf(s: StageInput): RequirementStage | null {
	switch (s.state) {
		case "dropped":
		case "refused":
			return null;
		case "draft":
			return "draft";
		case "agreed":
			return "agreed";
		case "deferred":
			return "deferred";
		case "delivered":
			return "check";
		case "accepted":
			return "done";
		case "in_delivery":
			if (s.attentionGroup === "needs_you") return "decide";
			// read off the wait's registry key, never its English: a rewording leaves the stage alone
			return s.waitingOn.says.who.key === "standing.who.independentJudge"
				? "prove"
				: "build";
	}
}

/**
 * Now holds what is building, proving, waiting on a decision or on a person's check; Next holds
 * agreed work and drafts; Later holds only what a person deferred (BC-8). Accepted and dropped work is
 * on no horizon.
 */
export function roadmapHorizonOf(s: StageInput): RoadmapHorizon | null {
	switch (requirementStageOf(s)) {
		case "build":
		case "decide":
		case "prove":
		case "check":
			return "now";
		case "agreed":
		case "draft":
			return "next";
		case "deferred":
			return "later";
		default:
			return null;
	}
}

/** Criteria with a failing verdict: judged either way, minus passing. */
export function failingOf(s: Pick<StageInput, "facts">): number {
	return Math.max(0, s.facts.judged - s.facts.passing);
}

/** A short name is at most six words (BC-3). */
export const SHORT_NAME_MAX_WORDS = 6;
export const shortNameWords = (s: string) =>
	s.trim().split(/\s+/).filter(Boolean).length;
