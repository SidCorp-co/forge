// A workflow design's approval state, declared once: core's `design_status` column reads the array
// (`workflows/design.ts` re-exports it) and every surface reads one label, one legend tone and one
// hint per value.

import type { IssueStatusTone } from "./issue-vocabulary.js";
import { defineMachine } from "./state-machine.js";

export const DESIGN_STATUSES = [
	"draft",
	"proposed",
	"approved",
	"returned",
] as const;
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
	proposed:
		"proposed: nothing that builds it is dispatched until an approver approves it",
	approved: "approved: work that builds it may start",
	returned: "returned: sent back to the master to revise",
};

// the design keeps one head status (domain-entities item 7), so a revision's own state is
// derived on read from the head and that revision's decision (core `workflows/design-standing.ts:revisionStateOf`)
export const DESIGN_REVISION_STATES = [
	"proposed",
	"current",
	"returned",
	"superseded",
] as const;
export type DesignRevisionState = (typeof DESIGN_REVISION_STATES)[number];

export const DESIGN_REVISION_STATE_LABELS: Record<DesignRevisionState, string> =
	{
		proposed: "Awaiting approval",
		current: "Approved",
		returned: "Returned",
		superseded: "Superseded",
	};

export const DESIGN_REVISION_STATE_TONES: Record<
	DesignRevisionState,
	IssueStatusTone
> = {
	proposed: "you",
	current: "ready",
	returned: "err",
	superseded: "done",
};

export const DESIGN_REVISION_STATE_GLYPHS: Record<DesignRevisionState, string> =
	{
		proposed: "●",
		current: "◆",
		returned: "↺",
		superseded: "×",
	};

export const DESIGN_REVISION_STATE_HINTS: Record<DesignRevisionState, string> =
	{
		proposed: "proposed: waiting on its approver to approve or return it",
		current: "current: the approved revision work builds against",
		returned: "returned: sent back with a reason; the master revises it",
		superseded:
			"superseded: a later revision replaced it, approved or proposed in its place",
	};

/** The approval lifecycle of a workflow design (`project_workflows.design_status`), moved only by the kernel. */
export const WORKFLOW_DESIGN_MACHINE = defineMachine({
	entity: "workflow_design",
	shapes: ["c3f92a74"],
	design: null,
	states: DESIGN_STATUSES,
	initial: ["draft"],
	terminal: [],
	reasonRequired: ["returned"],
	edges: [
		{ from: "draft", to: "proposed", act: "workflow_design.proposed", permission: "workflow-designs.write", guards: [] },
		{ from: "approved", to: "proposed", act: "workflow_design.proposed", permission: "workflow-designs.write", guards: [] },
		{ from: "returned", to: "proposed", act: "workflow_design.proposed", permission: "workflow-designs.write", guards: [] },
		{ from: "proposed", to: "approved", act: "workflow_design.approved", permission: "workflow-designs.approve", guards: [] },
		{ from: "proposed", to: "returned", act: "workflow_design.returned", permission: "workflow-designs.approve", guards: [] },
	],
});
