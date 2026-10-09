// What a checklist read answers for one item (REQ-34 BC-3, BC-5, BC-9, BC-26): each checklist its
// machine asks, as one definition gives it, with how the item stands against it now and every move
// the kernel judged by it. Core serves one per item kind (an issue, a feedback item, a requirement);
// a page draws the answers from here and never restates a question.

import type { ChecklistAnswer, ChecklistEvaluation, ChecklistForm } from "./checklists.js";
import type { GatedMoveStanding } from "./move-gates.js";
import type { Refusal } from "./refusal.js";

/** One move against one gate, passed or refused, as the kernel recorded it. */
export interface GatedMove {
	at: string;
	from: string | null;
	to: string;
	gate: string;
	standing: GatedMoveStanding;
	/** The checklist that judged it, or null for a move check's and a move recorded before. */
	checklist: { id: string; version: number } | null;
	/** The answers it was judged by, each given or assumed with its source; null where none were kept. */
	answers: ChecklistAnswer[] | null;
	refusals: Refusal[] | null;
	actor: { type: string; agency: string; id: string | null };
	source: string;
}

export interface ChecklistMove extends GatedMove {
	/** Only a passed move counts (BC-9): one recorded before the checklist reads `no_checklist`. */
	countsAsPassed: boolean;
}

export interface ChecklistRead {
	id: string;
	version: number;
	gates: { machine: string; from: readonly string[]; to: string };
	design: { flow: string; revision: number; step: string };
	/** The form a person fills, one field per question, in the checklist's order. */
	form: ChecklistForm;
	/** The JSON Schema of the answers a mover sends. */
	input: Record<string, unknown>;
	/**
	 * How the item stands against it now: what its record answers, what would be assumed, each gap in
	 * plain words. Null where the item is at no status the checklist is asked from, nor past it.
	 */
	now: ChecklistEvaluation | null;
	/** Its moves through this checklist, newest first. */
	moves: ChecklistMove[];
}

/** `GET /api/projects/:id/requirements/:req/checklist`. */
export interface RequirementChecklistsRead {
	requirementId: string;
	key: string;
	/** The head revision `now` reads; null while it has none. */
	revision: number | null;
	checklists: ChecklistRead[];
}

/** `GET /api/projects/:id/feedback/:fb/checklist`. */
export interface FeedbackChecklistsRead {
	feedbackId: string;
	key: string;
	checklists: ChecklistRead[];
}
