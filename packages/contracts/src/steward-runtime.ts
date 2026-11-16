// The steward runtime's own surface (REQ-48 BC-1, BC-12; lane B of docs/proposals/steward-agent.md):
// the doors a steward gateway turn may call, each act's menu of them, the project policy that turns
// the steward off, and what the runs read and the undo door answer. The run and
// act records themselves are `steward.ts`'s, shared with lane A.

import { z } from "zod";
import type { ProjectPermission } from "./permissions.js";
import type {
	StewardAct,
	StewardActRecord,
	StewardRunView,
} from "./steward.js";

/**
 * Every tool a steward gateway turn is offered, each one existing door (BC-12): the reads it decides
 * from and the writes it acts through. A steward turn is fenced to these names and refuses any other
 * by name (`assistant/turn-origin.ts:fenceToolsetToOrigin`).
 */
export const STEWARD_DOOR_TOOLS = [
	"steward_read_item",
	"steward_read_standings",
	"steward_list_requirements",
	"steward_read_requirement",
	"steward_read_feedback",
	"steward_read_issue",
	"steward_read_suggestion",
	"steward_read_master_standing",
	"steward_read_lesson",
	"steward_list_lessons",
	"steward_ask",
	"steward_decide",
	"steward_prepare_draft",
	"steward_comment_requirement",
	"steward_comment_issue",
	"steward_reject_breakdown",
	"steward_move_issue",
	"steward_set_requirement_owner",
	"steward_wake_master",
	"steward_write_note",
	"steward_raise_lesson_confusion",
] as const;
export type StewardDoorTool = (typeof STEWARD_DOOR_TOOLS)[number];

/** The doors each gateway act may call; a runner act carries its method in its brief instead. */
export const STEWARD_ACT_DOORS: Readonly<
	Record<StewardAct, readonly StewardDoorTool[]>
> = {
	note: [
		"steward_read_item",
		"steward_read_standings",
		"steward_read_lesson",
		"steward_list_lessons",
		"steward_write_note",
	],
	intake_check: [
		"steward_read_item",
		"steward_read_standings",
		"steward_list_requirements",
		"steward_read_requirement",
		"steward_ask",
		"steward_comment_requirement",
		"steward_write_note",
		"steward_read_lesson",
		"steward_list_lessons",
		"steward_raise_lesson_confusion",
	],
	breakdown_check: [
		"steward_read_item",
		"steward_read_standings",
		"steward_list_requirements",
		"steward_read_requirement",
		"steward_read_suggestion",
		"steward_ask",
		"steward_reject_breakdown",
		"steward_write_note",
		"steward_read_lesson",
		"steward_list_lessons",
		"steward_raise_lesson_confusion",
	],
	stuck_diagnosis: [
		"steward_read_item",
		"steward_read_standings",
		"steward_list_requirements",
		"steward_read_requirement",
		"steward_read_feedback",
		"steward_read_issue",
		"steward_read_master_standing",
		"steward_prepare_draft",
		"steward_decide",
		"steward_comment_issue",
		"steward_move_issue",
		"steward_set_requirement_owner",
		"steward_wake_master",
		"steward_write_note",
		"steward_read_lesson",
		"steward_list_lessons",
		"steward_raise_lesson_confusion",
	],
	output_check: [
		"steward_read_item",
		"steward_read_standings",
		"steward_read_issue",
		"steward_read_requirement",
		"steward_comment_issue",
		"steward_move_issue",
		"steward_wake_master",
		"steward_write_note",
		"steward_read_lesson",
		"steward_list_lessons",
		"steward_raise_lesson_confusion",
	],
	triage_draft: [],
	release_followthrough: [],
};

/**
 * The approvals each act's token names (REQ-48 r2 decision 2, as the coordinator amended it on
 * 2026-10-21): a named token holds an approval only where it names it, so an act whose token names
 * none cannot approve whatever its account holds. `breakdown_check` rejects a breakdown and never
 * accepts one, which its door menu holds to; `triage_draft` accepts only its own `feedback_triage`
 * suggestion, which the accept door holds to (`suggestions/accept-fence.ts`). Nothing declines.
 */
export const STEWARD_ACT_APPROVALS: Readonly<
	Record<StewardAct, readonly ProjectPermission[]>
> = {
	note: [],
	intake_check: [],
	breakdown_check: ["suggestions.approve"],
	triage_draft: ["feedback.approve", "suggestions.approve"],
	stuck_diagnosis: [],
	output_check: [],
	release_followthrough: ["feedback.approve"],
};

/** The name the steward's agent account carries on every page (BC-1). */
export const STEWARD_ACCOUNT_NAME = "Steward";

/**
 * Why `steward.budget` is refused (ISS-1255): what replaced the daily budget it lowered. Said by the
 * write refusal (core `project-config/rules.ts:checkRetiredStewardBudget`) and by the schema where the
 * value is not even in the old shape, so every write naming the key reads the same reason.
 */
export const STEWARD_BUDGET_RETIRED_DETAIL =
	"steward.budget is retired: the steward's runner jobs take the box's run slots like every other run, and a per-item runaway guard stops a run that repeats its act. Remove the key; steward.enabled: false turns the steward off.";

/**
 * The project document's `steward` key: `enabled`, absent is on. `budget` is retired: it is parsed in
 * its old shape only so a write naming it is refused by name; migration 0664 stripped every stored one.
 */
export const stewardPolicySchema = z.strictObject({
	enabled: z.boolean().optional(),
	budget: z
		.strictObject(
			{
				gatewayTurns: z
					.number({ error: STEWARD_BUDGET_RETIRED_DETAIL })
					.int({ error: STEWARD_BUDGET_RETIRED_DETAIL })
					.min(0, { error: STEWARD_BUDGET_RETIRED_DETAIL })
					.optional(),
				runnerJobs: z
					.number({ error: STEWARD_BUDGET_RETIRED_DETAIL })
					.int({ error: STEWARD_BUDGET_RETIRED_DETAIL })
					.min(0, { error: STEWARD_BUDGET_RETIRED_DETAIL })
					.optional(),
			},
			{ error: STEWARD_BUDGET_RETIRED_DETAIL },
		)
		.optional(),
});
export type StewardPolicy = z.infer<typeof stewardPolicySchema>;

/** `GET /api/projects/:id/steward-runs?subject=<REQ-n|FB-n|ISS-n>`: newest first. */
export interface StewardRunsResponse {
	runs: StewardRunView[];
}

/** `GET /api/projects/:id/steward-acts?subject=KEY`: every act the steward took on one item, newest first, uncapped. */
export interface StewardActsResponse {
	acts: StewardActRecord[];
}

/** `POST /api/projects/:id/steward-acts/:actId/undo`: the act as it stands now, and what its undo door answered. */
export interface StewardUndoResponse {
	act: StewardActRecord;
	undone: { door: string; status: number; wrote: string | null };
}
