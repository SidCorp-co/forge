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

/** Where a requirement stands. `null` for a dropped one, which is on no roadmap. */
export function requirementStageOf(s: StageInput): RequirementStage | null {
	switch (s.state) {
		case "dropped":
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

const WHO: Record<string, string> = {
	You: "You",
	"Independent judge": "Judge",
};
const codes = (act: string) => (act.match(/BC-\d+/g) ?? []).length;
const issues = (act: string) => act.match(/ISS-\d+/g) ?? [];
const plural = (n: number, one: string, many: string) =>
	`${n} ${n === 1 ? one : many}`;

/** Whom the requirement waits on and what, as one short phrase with no criterion codes, only counts. */
export function waitsLineOf(s: Pick<StageInput, "waitingOn">): {
	kind: "you" | "agent";
	text: string;
} {
	const { who: rawWho, act } = s.waitingOn;
	const who = WHO[rawWho] ?? rawWho;
	let what: string;
	const iss = issues(act);
	const n = codes(act);
	if (rawWho === "Issues") {
		const m = act.match(/^(\w+) (\d+) of (\d+)/);
		return {
			kind: "agent",
			text: m ? `${m[2]} of ${m[3]} issues ${String(m[1]).toLowerCase()}` : act,
		};
	}
	if (act.startsWith("make a decision"))
		what = `decide on ${iss[0] ?? "a question"}`;
	else if (act.startsWith("check"))
		what = `check ${plural(n, "criterion", "criteria")}`;
	else if (act.startsWith("judge"))
		what = `judge ${plural(n, "criterion", "criteria")}`;
	else if (act.startsWith("tie"))
		what = `re-tie ${plural(iss.length, "issue", "issues")}`;
	else if (act.startsWith("fix")) what = `fix ${n} failing`;
	else if (act.startsWith("trace"))
		what = `trace ${plural(n, "criterion", "criteria")}`;
	else if (act.startsWith("take")) what = `start ${iss.join(", ")}`;
	else if (act.startsWith("propose or drop")) what = "propose or drop";
	else if (act.startsWith("propose")) what = "write r1";
	else if (act.startsWith("revise")) what = "revise r1";
	else what = act;
	return {
		kind: rawWho === "You" ? "you" : "agent",
		text: what ? `${who} · ${what}` : who,
	};
}

/** A short name is at most six words (BC-3). */
export const SHORT_NAME_MAX_WORDS = 6;
export const shortNameWords = (s: string) =>
	s.trim().split(/\s+/).filter(Boolean).length;
