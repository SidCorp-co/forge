// A project's health and its trend (REQ-24): throughput, step failures, retries and interventions
// per day over a chosen window, each derived from records Forge already keeps. `GET
// /api/projects/:id/metrics/health?days=` answers it and the project dashboard draws it.

/** The windows the dashboard offers, in days. */
export const HEALTH_WINDOWS = [7, 14, 30, 90] as const;
export type HealthWindow = (typeof HEALTH_WINDOWS)[number];

/** The four figures, in the order the dashboard shows them. */
export const HEALTH_FIGURES = [
	"throughput",
	"stepFailures",
	"retries",
	"interventions",
] as const;
export type HealthFigure = (typeof HEALTH_FIGURES)[number];

/** Where each figure is read from: the record, never a counter kept for it (BC-2). */
export const HEALTH_SOURCES: Record<HealthFigure, string> = {
	throughput:
		"issues first shipped (kernel transitions into awaiting_release or closed)",
	stepFailures: "pipeline jobs that finished failed",
	retries: "pipeline jobs queued as a retry of an earlier job",
	interventions:
		"operator interventions in job history (cancel, resume, answer, inject)",
};

export type HealthDay = { day: string } & Record<HealthFigure, number>;

export interface ProjectHealth {
	projectId: string;
	days: number;
	/** One row per UTC day, oldest first, a day with nothing at zero. */
	series: HealthDay[];
	totals: Record<HealthFigure, number>;
	/** The same window just before this one, so a trend reads against it. */
	previous: Record<HealthFigure, number>;
}
