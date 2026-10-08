// Every checklist a gated move asks, by id. A machine edge names one (`MachineEdge.checklist`) and
// the kernel runs it on that edge; `state-machine.ts:defineMachine` refuses an edge naming an id this
// registry does not hold, or one whose `gates` is another edge.

import { type Checklist, defineChecklist } from "./checklists.js";

/** Issue lifecycle r12, step ready-check: what an issue answers before it opens. */
export const ISSUE_READY_CHECKLIST = defineChecklist({
	id: "issue_ready",
	title: "Issue ready",
	gates: { machine: "issue", from: ["draft"], to: "open" },
	design: { flow: "issue-lifecycle", revision: 12, step: "ready-check" },
	shapes: ["df56d5bf"],
	questions: [
		{
			id: "requirement",
			prompt: "Which agreed requirement does this issue deliver, and at which revision?",
			fix: "Link the issue to the agreed or accepted requirement it delivers, at the revision its plan is written against.",
			answer: { kind: "text", maxLength: 200 },
			answeredBy: { by: "record", field: "requirementId" },
			need: { blocking: true },
		},
		{
			id: "criteria",
			prompt: "What are its criteria, each traced to a business criterion of that revision?",
			fix: "Write the issue's numbered criteria and trace each one to a BC that stands at the revision it plans against.",
			answer: { kind: "text", maxLength: 2000 },
			answeredBy: { by: "record", field: "acceptanceCriteria" },
			need: { blocking: true },
		},
		{
			id: "design",
			prompt: "Which design revision does it build, or none?",
			fix: "Name the workflow design the issue builds, or leave it building none.",
			answer: { kind: "text", maxLength: 200 },
			answeredBy: { by: "record", field: "buildsWorkflow" },
			need: { blocking: true },
		},
		{
			id: "hotfix",
			prompt: "Is it a hotfix for a production failure? If so, which FB-n or Sentry issue does it fix, and which criterion does it restore, or which requirement revision will add one?",
			fix: "Answer it in the move, or leave it to take the assumed answer.",
			answer: { kind: "text", maxLength: 500 },
			answeredBy: { by: "mover" },
			need: {
				blocking: false,
				recommended: "Not a hotfix: it fixes no production failure.",
			},
			open: {
				question: "0769f177-2941-42db-81a6-5346b00252bb",
				note: "REQ-34 does not yet say what hotfix obligations are; Issue lifecycle r12 draws this reading as an assumed answer.",
			},
		},
	],
});

export const CHECKLISTS = {
	issue_ready: ISSUE_READY_CHECKLIST,
} as const satisfies Readonly<Record<string, Checklist>>;

export type ChecklistId = keyof typeof CHECKLISTS;

export function isChecklistId(id: string): id is ChecklistId {
	return Object.hasOwn(CHECKLISTS, id);
}

/** The checklists a machine's edges name, each once, in edge order. */
export function checklistsOn(machine: {
	readonly edges: readonly { readonly checklist?: string }[];
}): (typeof CHECKLISTS)[ChecklistId][] {
	const ids = [...new Set(machine.edges.flatMap((e) => (e.checklist ? [e.checklist] : [])))];
	return ids.filter(isChecklistId).map((id) => CHECKLISTS[id]);
}
