// A workflow design's approval state, declared once: core's `design_status` column reads the array
// (`workflows/design.ts` re-exports it) and every surface reads one label, one legend tone and one
// hint per value.

import type { IssueStatusTone } from "./issue-vocabulary.js";

export const DESIGN_STATUSES = ["draft", "proposed", "approved", "returned"] as const;
export type DesignStatus = (typeof DESIGN_STATUSES)[number];

export const DESIGN_STATUS_LABELS: Record<DesignStatus, string> = {
	draft: "Draft",
	proposed: "Awaiting approval",
	approved: "Approved",
	returned: "Returned",
};

export const DESIGN_STATUS_TONES: Record<DesignStatus, IssueStatusTone> = {
	draft: "neutral",
	proposed: "you",
	approved: "ready",
	returned: "err",
};

export const DESIGN_STATUS_GLYPHS: Record<DesignStatus, string> = {
	draft: "○",
	proposed: "●",
	approved: "◆",
	returned: "↺",
};

export const DESIGN_STATUS_HINTS: Record<DesignStatus, string> = {
	draft: "draft: the master is still drawing it",
	proposed: "proposed: nothing that builds it is dispatched until a person approves it",
	approved: "approved: work that builds it may start",
	returned: "returned: sent back to the master to revise",
};
