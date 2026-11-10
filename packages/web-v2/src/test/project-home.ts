import type { HomeNeedsYou, ProjectHome } from "@forge/contracts/project-home";

/** The project home's one read for a project with nothing in it yet; `needsYou` where a test sets one. */
export const emptyHome = (projectId: string, needsYou: HomeNeedsYou = { decisions: [], total: 0 }): ProjectHome => ({
  projectId,
  asOf: "2026-11-10T00:00:00.000Z",
  tz: "UTC",
  product: { requirements: 0, byState: [], criteria: { proven: 0, total: 0 }, areas: [], feedbackOpen: 0 },
  delivery: { open: 0, byStatus: [], running: 0, issues: [], truncated: false },
  release: { days: [], shipped: 0, issues: 0, byState: [], timeline: [], recent: [] },
  audit: { open: 0, cleared: 0, byKind: [], byRating: [], cells: [] },
  feedback: { weeks: [] },
  needsYou,
});
