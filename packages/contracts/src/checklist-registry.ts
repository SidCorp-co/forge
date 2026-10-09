// Every checklist a gated move asks, by id. A machine edge names one (`MachineEdge.checklist`) and
// the kernel runs it on that edge; `state-machine.ts:defineMachine` refuses an edge naming an id this
// registry does not hold, or one whose `gates` is another edge.

import { type Checklist, defineChecklist } from "./checklists.js";
import {
	FEEDBACK_KIND_LABELS,
	FEEDBACK_KINDS,
	FEEDBACK_ROUTE_LABELS,
	FEEDBACK_ROUTES,
	FEEDBACK_SEVERITIES,
	FEEDBACK_SEVERITY_LABELS,
} from "./feedback-terms.js";

/** Issue lifecycle r12, step ready-check: what an issue answers before it opens. */
export const ISSUE_READY_CHECKLIST = defineChecklist({
	id: "issue_ready",
	title: "Issue ready",
	gates: { machine: "issue", from: ["draft"], to: "open" },
	design: { flow: "issue-lifecycle", revision: 12, step: "ready-check" },
	shapes: ["df56d5bf", "31b93801"],
	questions: [
		{
			id: "requirement",
			prompt: "Which agreed requirement does this issue deliver, and at which revision?",
			fix: "Link the issue to the agreed or accepted requirement it delivers, then write its plan: saving the plan records the revision of that requirement it is written against.",
			answer: { kind: "text", maxLength: 200 },
			answeredBy: { by: "record", field: "requirementId", label: "linked requirement and its plan" },
			need: { blocking: true },
		},
		{
			id: "criteria",
			prompt: "What are its criteria, each traced to a business criterion of that revision?",
			fix: "Write the issue's numbered acceptance criteria and trace each one to a business criterion (BC) of the requirement revision its plan is written against.",
			answer: { kind: "text", maxLength: 2000 },
			answeredBy: { by: "record", field: "acceptanceCriteria", label: "acceptance criteria" },
			need: { blocking: true },
		},
		{
			id: "design",
			prompt: "Which design revision does it build, or none?",
			fix: "Name the workflow design the issue builds, or leave it building none.",
			answer: { kind: "text", maxLength: 200 },
			answeredBy: { by: "record", field: "buildsWorkflow", label: "workflow design" },
			need: { blocking: true },
		},
		{
			id: "hotfix",
			prompt: "Is it a hotfix for a production failure? If so, which FB-n or Sentry issue does it fix, and which criterion does it restore, or which requirement revision will add one?",
			fix: "If it is a hotfix, answer it. If not, leave it unanswered and the assumed answer is taken.",
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

const options = <V extends string>(values: readonly V[], labels: Record<V, string>) =>
	values.map((value) => ({ value, label: labels[value] }));

/** The answer a triage gives to "Which business criterion does it violate, or none?" when it names none. */
export const NO_CRITERION = "none";

/**
 * Feedback lifecycle r14, step triage-check (Feedback triage r16, step check): what a feedback item
 * answers before it is triaged. Kind and requirement are the item's own; a triage corrects the kind
 * with `kind`, and the requirement by retargeting the item or naming a criterion. Short form (BC-6):
 * a bug naming a criterion needs only that criterion, the reproduction and the severity, since the
 * requirement is the criterion's and the route is an issue (`feedback-triage.ts:triageAnswersOf`).
 */
export const FEEDBACK_TRIAGE_CHECKLIST = defineChecklist({
	id: "feedback_triage",
	title: "Feedback triage",
	gates: { machine: "feedback", from: ["new", "reopened"], to: "triaged" },
	design: { flow: "feedback-lifecycle", revision: 14, step: "triage-check" },
	shapes: ["641ec09f"],
	questions: [
		{
			id: "kind",
			prompt: "Is it a bug, a change request, a question, an idea or a contract change?",
			fix: "Correct what it is with the triage.",
			answer: { kind: "choice", options: options(FEEDBACK_KINDS, FEEDBACK_KIND_LABELS) },
			answeredBy: { by: "record", field: "kind", label: "reported type" },
			need: { blocking: true },
		},
		{
			id: "requirement",
			prompt: "Which requirement is it about, or none?",
			fix: "Retarget the item to the requirement it is about, or name the criterion it violates.",
			answer: { kind: "text", maxLength: 200 },
			answeredBy: { by: "record", field: "requirementId", label: "target or violated criterion" },
			need: { blocking: true },
		},
		{
			id: "criterion",
			prompt: "Which business criterion does it violate, or none?",
			fix: `Name it as REQ-n BC-m, or answer "${NO_CRITERION}".`,
			answer: { kind: "text", maxLength: 200 },
			answeredBy: { by: "mover" },
			need: { blocking: true },
		},
		{
			id: "severity",
			prompt: "How severe is it?",
			fix: "Pick low, medium, high or critical.",
			answer: { kind: "choice", options: options(FEEDBACK_SEVERITIES, FEEDBACK_SEVERITY_LABELS) },
			answeredBy: { by: "mover" },
			need: { blocking: true },
		},
		{
			id: "reproduced",
			prompt: "Was it reproduced, and with what evidence?",
			fix: "Say how it was reproduced and what shows it, or why it could not be.",
			answer: { kind: "text", maxLength: 2000 },
			answeredBy: { by: "mover" },
			need: { blocking: true },
		},
		{
			id: "route",
			prompt: "Which route does it take?",
			fix: "Pick issue, revision, new requirement, answer or duplicate.",
			answer: { kind: "choice", options: options(FEEDBACK_ROUTES, FEEDBACK_ROUTE_LABELS) },
			answeredBy: { by: "mover" },
			need: { blocking: true },
		},
	],
});

export const CHECKLISTS = {
	issue_ready: ISSUE_READY_CHECKLIST,
	feedback_triage: FEEDBACK_TRIAGE_CHECKLIST,
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
