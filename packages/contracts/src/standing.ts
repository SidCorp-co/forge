// One standing shape for every read model (pattern v2 BC-19, ISS-164): the group a list draws a row
// under and whom the row waits on, in one vocabulary, so two screens reading one row cannot disagree.

import type { IssueStatusTone } from "./issue-vocabulary.js";
import type { ProjectPermission } from "./permissions.js";

/** Every party a row can wait on, across every read model. A slice declares the subset it serves. */
export const WAITING_KINDS = [
	"you",
	"person",
	"admins",
	"writers",
	"agent",
	"run",
	"master",
	"judge",
	"issue",
	"feedback",
	"release",
	"project",
	"gate",
	"machine",
	"system",
	"none",
] as const;
export type WaitingKind = (typeof WAITING_KINDS)[number];

/** How the shared Waiting-on cell marks each kind. */
export const WAITING_MARKS = [
	"you",
	"person",
	"agent",
	"system",
	"issue",
	"release",
	"project",
	"none",
] as const;
export type WaitingMark = (typeof WAITING_MARKS)[number];

export const WAITING_KIND_MARKS: Record<WaitingKind, WaitingMark> = {
	you: "you",
	person: "person",
	admins: "person",
	writers: "person",
	agent: "agent",
	run: "agent",
	master: "agent",
	judge: "agent",
	issue: "issue",
	feedback: "issue",
	release: "release",
	project: "project",
	gate: "system",
	machine: "system",
	system: "system",
	none: "none",
};

export interface WaitingOn<K extends WaitingKind = WaitingKind> {
	kind: K;
	/** Sentence-case name: "You", "Minh", "Master", "ISS-12", "A project admin", "Nobody". */
	who: string;
	/** What they owe, lower-case after the name: "answer a question", "Test · 12 min"; empty when
	 *  the name says it all. */
	act: string;
	/** Why, for the tooltip: the rule of the read model that put it there. */
	rule: string;
	/** What doing the act changes, in one sentence a person reads before pressing it; absent where the act says it all. */
	effect?: string;
	/** The key `who` names when it is an entity (an issue, feedback, a contract); else null. */
	ref: string | null;
	/** When what they owe has a deadline (an SLA, a gate that resumes by itself); else null. */
	dueAt: string | null;
}

/** Every group a list draws rows under, across every read model, Needs you first. A slice declares
 *  the subset it serves, in the order it draws them. */
export const STANDING_GROUPS = [
	"needs_you",
	"waiting",
	"moving",
	"running",
	"stuck",
	"waiting_gate",
	"queued",
	"paused",
	"deferred",
	"on",
	"off",
	"produced",
	"nothing_produced",
	"failed_or_skipped",
	"filed",
	"quiet",
	"steady",
	"closed",
	"done",
	"stopped",
	"finished",
] as const;
export type StandingGroup = (typeof STANDING_GROUPS)[number];

export interface StandingGroupLabel {
	label: string;
	hint: string | null;
	tone: IssueStatusTone;
	collapsed: boolean;
}

export type StandingGroupLabels<G extends StandingGroup> = Record<
	G,
	StandingGroupLabel
>;

export interface Standing<
	G extends StandingGroup = StandingGroup,
	K extends WaitingKind = WaitingKind,
> {
	attentionGroup: G;
	waitingOn: WaitingOn<K>;
}

/** The one needs-you predicate: a row needs the viewer when its read model groups it there. */
export const needsViewer = (s: Pick<Standing, "attentionGroup">): boolean =>
	s.attentionGroup === "needs_you";

export const nobodyWaits = (rule: string): WaitingOn<"none"> => ({
	kind: "none",
	who: "Nobody",
	act: "",
	rule,
	ref: null,
	dueAt: null,
});

/** A permission's holders as one `who`: a few by name and the count of the rest ("Ana", "Ana, Bo", "Ana, Bo, Chi +2"), `Nobody` for none. */
export function holdersWho(names: readonly string[]): string {
	if (names.length === 0) return "Nobody";
	const shown = names.slice(0, 3).join(", ");
	return names.length > 3 ? `${shown} +${names.length - 3}` : shown;
}

/** The act a wait names when nobody holds the permission it needs: the act, then where it is granted. */
export function nobodyHoldsAct(
	act: string,
	permission: ProjectPermission,
): string {
	return `${act}: no person on this project holds ${permission} until it is granted under Settings → Members`;
}
