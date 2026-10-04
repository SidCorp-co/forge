// cm:why the navigation's waiting-on-you counts and the dashboard's delivery row, served by one read
// (`GET /api/projects/:id/needs-you`, ISS-75): each count is taken from the very read model the list it
// opens draws, so the number beside a menu entry and the list behind it never disagree (REQ-11 BC-10)

/** The menu entries that carry a waiting-on-you count, in menu order. */
export const NEEDS_YOU_AREAS = [
	"requirements",
	"releases",
	"feedback",
	"issues",
	"contracts",
] as const;
export type NeedsYouAreaKey = (typeof NEEDS_YOU_AREAS)[number];

export const NEEDS_YOU_AREA_LABELS: Record<NeedsYouAreaKey, string> = {
	requirements: "Requirements",
	releases: "Releases",
	feedback: "Feedback",
	issues: "Issues",
	contracts: "Contracts",
};

/** One act the viewer owes, and on how many rows of the list: "accept r2" on 2 requirements. */
export interface NeedsYouAct {
	act: string;
	count: number;
}

export interface NeedsYouArea {
	/** Rows of the area's list in its waiting-on-you group, for this viewer. */
	you: number;
	/** What those rows wait on the viewer to do, most frequent first; the tooltip's detail. */
	acts: NeedsYouAct[];
}

export interface NeedsYouResponse {
	generatedAt: string;
	areas: Record<NeedsYouAreaKey, NeedsYouArea>;
	/** Requirements whose derived state is `in_delivery`, as the requirement list groups them. */
	requirementsInDelivery: number;
	/** Feedback still to be triaged: a phase in `FEEDBACK_UNTRIAGED_PHASES`. */
	untriagedFeedback: number;
}
