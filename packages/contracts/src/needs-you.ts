// cm:why the navigation's waiting-on-you counts and the dashboard's delivery row, served by one read
// (`GET /api/projects/:id/needs-you`, ISS-75): each count is taken from the very read model the list it
// opens draws, so the number beside a menu entry and the list behind it never disagree (REQ-11 BC-10)

export const NEEDS_YOU_AREAS = [
	"requirements",
	"releases",
	"feedback",
	"issues",
	"contracts",
	"automation",
] as const;
export type NeedsYouAreaKey = (typeof NEEDS_YOU_AREAS)[number];

export const NEEDS_YOU_AREA_LABELS: Record<NeedsYouAreaKey, string> = {
	requirements: "Requirements",
	releases: "Releases",
	feedback: "Feedback",
	issues: "Issues",
	contracts: "Contracts",
	automation: "Automation",
};

export interface NeedsYouAct {
	act: string;
	count: number;
}

export interface NeedsYouArea {
	you: number;
	/** What those rows wait on the viewer to do, most frequent first; the tooltip's detail. */
	acts: NeedsYouAct[];
}

export interface NeedsYouResponse {
	generatedAt: string;
	areas: Record<NeedsYouAreaKey, NeedsYouArea>;
	requirementsInDelivery: number;
	untriagedFeedback: number;
}
