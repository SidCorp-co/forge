// What waits on the viewer, served by one read (`GET /api/projects/:id/needs-you`, ISS-75, ISS-164):
// each row and count is taken from the read model the list it opens draws, under the one predicate
// `standing.ts:needsViewer`, so a menu count, the dashboard, the overview and the inbox never disagree.

import type { WrittenLang } from "./written-lang.js";
import type { Said } from "./said.js";
import type { WaitingOn } from "./standing.js";

export const NEEDS_YOU_AREAS = [
	"requirements",
	"releases",
	"feedback",
	"issues",
	"contracts",
	"designs",
	"automation",
	"questions",
] as const;
export type NeedsYouAreaKey = (typeof NEEDS_YOU_AREAS)[number];

export const NEEDS_YOU_AREA_LABELS: Record<NeedsYouAreaKey, string> = {
	requirements: "Requirements",
	releases: "Releases",
	feedback: "Feedback",
	issues: "Issues",
	contracts: "Contracts",
	designs: "Workflows",
	automation: "Automation",
	questions: "Questions",
};

/**
 * Whose list a needs-you row belongs on. `asks`: what a project member owes as a person — a
 * question, an approval, a decision, an accept, a promote or a drop. `ops`: Forge's own upkeep — an
 * agent report to triage, a schedule's owner, a contract to repin — which Development reads, never
 * the person's Needs you. One map, so the home, /attention and the status report count one set.
 */
export const NEEDS_YOU_SPACES = ["asks", "ops"] as const;
export type NeedsYouSpace = (typeof NEEDS_YOU_SPACES)[number];

export const NEEDS_YOU_AREA_SPACE: Record<NeedsYouAreaKey, NeedsYouSpace> = {
	requirements: "asks",
	releases: "asks",
	feedback: "asks",
	issues: "asks",
	designs: "asks",
	questions: "asks",
	contracts: "ops",
	automation: "ops",
};

/** The rows a person owes, in their order: the one filter every person-facing list reads. */
export const asksOf = <T extends { space: NeedsYouSpace }>(items: readonly T[]): T[] =>
	items.filter((i) => i.space === "asks");

/** What a needs-you row is, so a screen can open it. */
export const NEEDS_YOU_ENTITIES = [
	"requirement",
	"release",
	"feedback",
	"issue",
	"contract",
	"schedule",
	"report",
	"workflow",
	"question",
] as const;
export type NeedsYouEntity = (typeof NEEDS_YOU_ENTITIES)[number];

/** One row a slice's read model groups `needs_you` for the viewer, with that model's waiting-on. */
export interface NeedsYouItem {
	area: NeedsYouAreaKey;
	/** Whose list it belongs on (`NEEDS_YOU_AREA_SPACE`): a member's ask, or Forge ops' upkeep. */
	space: NeedsYouSpace;
	entity: NeedsYouEntity;
	/** The row's key: ISS-n, REQ-n, FB-n, a release version, a contract ref, a schedule or report id, a design's flow, a question's id. */
	key: string;
	/** The row's title in English: its writer's words, or Forge's own where nobody wrote one. */
	title: string;
	/** The language `title` was written in; null when Forge composed it or the language was not kept. */
	titleLang: WrittenLang | null;
	waitingOn: WaitingOn;
	touchedAt: string | null;
	/** `title` as said (`said.ts`): a writer's words verbatim, Forge's own by key. */
	says: { title: Said };
}

/** A member's ask read across every project the viewer can see (`GET /api/me/attention`); ops rows stay in each project's Development. */
export interface NeedsYouProjectItem extends NeedsYouItem {
	projectSlug: string;
	projectName: string;
}

export interface NeedsYouAct {
	act: string;
	count: number;
	/** `act` as said (`said.ts`). */
	says: { act: Said };
}

export interface NeedsYouArea {
	you: number;
	/** What those rows wait on the viewer to do, most frequent first; the tooltip's detail. */
	acts: NeedsYouAct[];
}

export interface NeedsYouResponse {
	generatedAt: string;
	areas: Record<NeedsYouAreaKey, NeedsYouArea>;
	/** Every row behind the counts, area by area in `NEEDS_YOU_AREAS` order, newest first. */
	items: NeedsYouItem[];
	/** How many of `items` are a member's asks: the one Needs you count the home, /attention and the status report show. */
	asks: number;
	requirementsInDelivery: number;
	untriagedFeedback: number;
}

/** The workspace pulse's queue of conditions a person or the machine owes (`GET /api/me/pulse`), in
 *  the tie-break order of last resort. */
export const PULSE_ACTION_KEYS = [
	"stuckRuns",
	"abandonedIssues",
	"releaseWaiting",
	"notOnLive",
	"liveUnmeasured",
	"neverRanProjects",
	"silentProjects",
] as const;
export type PulseActionKey = (typeof PULSE_ACTION_KEYS)[number];

export const PULSE_ACTION_OWNERS = ["person", "machine"] as const;
export type PulseActionOwner = (typeof PULSE_ACTION_OWNERS)[number];

export const PULSE_ACTION_LABELS: Record<
	PulseActionKey,
	{ label: string; owner: PulseActionOwner; hint: string }
> = {
	stuckRuns: {
		label: "Runs claimed but empty",
		owner: "machine",
		hint: "The control plane still calls these open and no job is under them.",
	},
	abandonedIssues: {
		label: "In-flight issues nobody is working",
		owner: "person",
		hint: "In progress, no live job, idle past the threshold — nothing will pick these up on its own.",
	},
	releaseWaiting: {
		label: "Waiting to be released",
		owner: "person",
		hint: "Merged and waiting on a release: on Releases, Cut the version, then Approve release where the project asks for approval.",
	},
	notOnLive: {
		label: "Closed, not on production",
		owner: "person",
		hint: "Closed on a promotion that has not happened: a commit of each is on the base branch and not the live one.",
	},
	liveUnmeasured: {
		label: "Promote projects Forge could not fully compare",
		owner: "person",
		hint: "Forge cannot tell whether closed issues here reached the live branch: the comparison failed, was cut short, or was taken before they merged.",
	},
	neverRanProjects: {
		label: "Projects holding a backlog with no pipeline",
		owner: "person",
		hint: "These have issues and have never started a run.",
	},
	silentProjects: {
		label: "Projects gone quiet",
		owner: "machine",
		hint: "A backlog, and the last run is older than the threshold.",
	},
};

export interface PulseActionRecord {
	key: string;
	label: string;
	detail: string;
	/** `detail` as said (`said.ts`); a title or a slug is carried as written. */
	says: { detail: Said };
	href: string;
	/** Null where the record has no age: a refused comparison says when it was read, not since when. */
	ageSeconds: number | null;
}

export interface PulseActionRow {
	key: PulseActionKey;
	label: string;
	hint: string;
	owner: PulseActionOwner;
	/** Every record the condition holds. */
	count: number;
	/** The records the response named, never more than `count`. */
	records: PulseActionRecord[];
	/** Null where no record under the row has an age. */
	oldestSeconds: number | null;
}
