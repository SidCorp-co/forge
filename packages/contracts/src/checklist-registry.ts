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

const text = (maxLength: number) => ({ kind: "text", maxLength }) as const;
const required = { blocking: true } as const;

/** Requirement lifecycle r15, step ready_check: what a draft answers before it is agreed. */
export const REQUIREMENT_READY_CHECKLIST = defineChecklist({
	id: "requirement_ready",
	title: "Requirement ready",
	gates: { machine: "requirement", from: ["draft"], to: "agreed" },
	design: { flow: "requirement-lifecycle", revision: 15, step: "ready_check" },
	shapes: ["3d9941e4"],
	questions: [
		{
			id: "problem",
			prompt: "What problem does it solve?",
			fix: 'State the problem in the goal, on a line starting "Problem:".',
			answer: text(2000),
			answeredBy: { by: "record", field: "revision.spec.goal", label: "goal" },
			need: required,
		},
		{
			id: "kind",
			prompt: "Is it a process, a rule, a screen or a report?",
			fix: "Set the kind of its head revision.",
			answer: text(200),
			answeredBy: { by: "record", field: "revision.kind", label: "kind" },
			need: { blocking: false, recommended: "Not stated." },
		},
		{
			id: "who",
			prompt: "Who is it for?",
			fix: "Name at least one persona it is for.",
			answer: text(2000),
			answeredBy: { by: "record", field: "revision.spec.personas", label: "personas" },
			need: required,
		},
		{
			id: "value",
			prompt: "What value does it give them?",
			fix: 'State the value in the goal, on a line starting "Value:".',
			answer: text(2000),
			answeredBy: { by: "record", field: "revision.spec.goal", label: "goal" },
			need: required,
		},
		{
			id: "measured",
			prompt: "How is its success measured?",
			fix: 'State the measure in the goal, on a line starting "Measured by:".',
			answer: text(2000),
			answeredBy: { by: "record", field: "revision.spec.goal", label: "goal" },
			need: required,
		},
		{
			id: "criteria",
			prompt: "Which checkable business criteria does it hold?",
			fix: "Write at least one business criterion on its head revision.",
			answer: text(2000),
			answeredBy: { by: "record", field: "revision.criteria", label: "business criteria" },
			need: required,
		},
		{
			id: "questions",
			prompt: "Is a blocking question still open?",
			fix: "Answer each blocking question, or mark it not blocking.",
			answer: text(2000),
			answeredBy: { by: "record", field: "revision.spec.openQuestions", label: "open questions" },
			need: required,
		},
		{
			id: "workflows",
			prompt: "Which workflows does it touch?",
			fix: "Link each workflow design it changes or serves.",
			answer: text(2000),
			answeredBy: { by: "record", field: "requirement.workflows", label: "linked workflow designs" },
			need: required,
		},
		{
			id: "outOfScope",
			prompt: "What is out of scope?",
			fix: "List what it leaves out, or leave it unanswered.",
			answer: text(2000),
			answeredBy: { by: "record", field: "revision.spec.scopeOut", label: "out of scope" },
			need: { blocking: false, recommended: "Nothing stated." },
		},
		{
			id: "roadmap",
			prompt: "Which roadmap lane is it in?",
			fix: 'State the lane in the goal, on a line starting "Roadmap:".',
			answer: text(200),
			answeredBy: { by: "record", field: "revision.spec.goal", label: "goal" },
			need: { blocking: false, recommended: "Next." },
		},
	],
});

/** Requirement lifecycle r15, step acceptance_check: what a delivered requirement answers before it is accepted. */
export const REQUIREMENT_ACCEPTANCE_CHECKLIST = defineChecklist({
	id: "requirement_acceptance",
	title: "Acceptance",
	gates: { machine: "requirement", from: ["agreed"], to: "accepted" },
	design: { flow: "requirement-lifecycle", revision: 15, step: "acceptance_check" },
	shapes: ["57f88d2f"],
	questions: [
		{
			id: "shipped",
			prompt: "Has a release shipped every live issue?",
			fix: "Wait for a release to ship each one, or drop those not being built.",
			answer: text(2000),
			answeredBy: { by: "record", field: "requirement.issues", label: "linked issues" },
			need: required,
		},
		{
			id: "verdicts",
			prompt: "Does every current criterion pass on the running build?",
			fix: "Have each one judged on the running build; a fail is filed as feedback.",
			answer: text(2000),
			answeredBy: { by: "record", field: "requirement.coverage", label: "verdicts on the running build" },
			need: required,
		},
		{
			id: "evidence",
			prompt: "Does each counted verdict cite its evidence?",
			fix: "Judge each one again, citing what the verdict was taken from.",
			answer: text(2000),
			answeredBy: { by: "record", field: "requirement.evidence", label: "verdict evidence" },
			need: required,
		},
	],
});

/** Requirement lifecycle r15, step design_check: what a workflow design answers before it is approved. */
export const WORKFLOW_APPROVAL_CHECKLIST = defineChecklist({
	id: "workflow_approval",
	title: "Workflow approval",
	gates: { machine: "workflow_design", from: ["proposed"], to: "approved" },
	design: { flow: "requirement-lifecycle", revision: 15, step: "design_check" },
	shapes: ["b534fd6d"],
	questions: [
		{
			id: "shape",
			prompt: "Does it draw a flow, or a structure?",
			fix: "Draw it in a diagram template.",
			answer: {
				kind: "choice",
				options: [
					{ value: "flow", label: "A flow: steps an item passes through" },
					{ value: "structure", label: "A structure: parts and how they connect" },
				],
			},
			answeredBy: { by: "record", field: "design.template", label: "diagram template" },
			need: required,
		},
		{
			id: "criteria",
			prompt: "Which business criteria does each step serve?",
			fix: "Trace the business criteria its steps serve, on the requirements linking it.",
			answer: text(2000),
			answeredBy: { by: "record", field: "design.traces", label: "criteria traced to its steps" },
			need: required,
		},
		{
			id: "roles",
			prompt: "Who owns each step, and who does it wait on?",
			fix: "Name an owner, lane or persona on its steps.",
			answer: text(2000),
			answeredBy: { by: "record", field: "design.owners", label: "step owners and lanes" },
			need: required,
		},
		{
			id: "exceptions",
			prompt: "Is each refusal, return and failure drawn?",
			fix: "Draw each refusal, return and failure as a condition, test or failure edge.",
			answer: text(2000),
			answeredBy: { by: "record", field: "design.exceptions", label: "conditions, tests and failure edges" },
			need: required,
			when: { question: "shape", isOneOf: ["flow"] },
		},
		{
			id: "changes",
			prompt: "What changed from the last approved revision?",
			fix: "Propose the revision again so its change can be computed.",
			answer: text(2000),
			answeredBy: { by: "record", field: "design.changes", label: "computed change" },
			need: required,
		},
	],
});

/** Requirement lifecycle r15, step breakdown_check: what a breakdown answers before it is accepted. */
export const BREAKDOWN_CHECKLIST = defineChecklist({
	id: "breakdown",
	title: "Breakdown",
	gates: { machine: "suggestion", from: ["proposed"], to: "accepted" },
	design: { flow: "requirement-lifecycle", revision: 15, step: "breakdown_check" },
	shapes: ["2fe61f83"],
	questions: [
		{
			id: "kind",
			prompt: "Is it a breakdown?",
			fix: "Nothing to fix: the kind is the suggestion's own.",
			answer: {
				kind: "choice",
				options: [
					{ value: "breakdown", label: "A breakdown of a requirement into issues" },
					{ value: "other", label: "Another kind of suggestion" },
				],
			},
			answeredBy: { by: "record", field: "suggestion.kind", label: "kind" },
			need: required,
		},
		{
			id: "criteria",
			prompt: "Does each issue hold criteria traced to a business criterion?",
			fix: "Give each issue criteria, each tracing a current business criterion.",
			answer: text(2000),
			answeredBy: { by: "record", field: "payload.issues.criteria", label: "issue criteria" },
			need: required,
			when: { question: "kind", isOneOf: ["breakdown"] },
		},
		{
			id: "coverage",
			prompt: "Is every current business criterion traced, or listed uncovered?",
			fix: "Trace each one from an issue, or list it uncovered with a reason.",
			answer: text(2000),
			answeredBy: { by: "record", field: "payload.uncovered", label: "traces and uncovered list" },
			need: required,
			when: { question: "kind", isOneOf: ["breakdown"] },
		},
		{
			id: "complexity",
			prompt: "Does each issue state its complexity?",
			fix: "Give each issue a complexity.",
			answer: text(2000),
			answeredBy: { by: "record", field: "payload.issues.complexity", label: "complexity" },
			need: required,
			when: { question: "kind", isOneOf: ["breakdown"] },
		},
	],
});

/**
 * Requirement lifecycle r15, step release_check: what an approver reads before a release goes to
 * production, asked only where the project's `release.approval.required` is on. No machine holds a
 * release approval's states yet, so its decision (core `release-batch/approvals.ts:decideApproval`)
 * judges it, not the kernel, and it stays out of `CHECKLISTS`, the checklists a machine edge names:
 * a reader of machine-gated moves (core `lifecycle/gated-moves.ts`) finds no table to count it in.
 */
export const RELEASE_APPROVAL_CHECKLIST = defineChecklist({
	id: "release_approval",
	title: "Release approval",
	gates: { machine: "release_approval", from: ["pending"], to: "approved" },
	design: { flow: "requirement-lifecycle", revision: 15, step: "release_check" },
	shapes: ["48b305a2"],
	questions: [
		{
			id: "carried",
			prompt: "Which requirements does it carry, each at which revision?",
			fix: "Cut the release again from issues that landed.",
			answer: text(2000),
			answeredBy: { by: "record", field: "release.requirements", label: "requirements carried" },
			need: required,
		},
		{
			id: "verdicts",
			prompt: "Is every carried criterion's latest verdict a pass?",
			fix: "Have each one judged on the commit it ships; a fail is filed as feedback.",
			answer: text(2000),
			answeredBy: { by: "record", field: "release.verdicts", label: "latest verdicts" },
			need: required,
		},
		{
			id: "reason",
			prompt: "Why may it go to production?",
			fix: "Say why you approve it.",
			answer: text(1000),
			answeredBy: { by: "mover" },
			need: required,
		},
	],
});

export const CHECKLISTS = {
	issue_ready: ISSUE_READY_CHECKLIST,
	feedback_triage: FEEDBACK_TRIAGE_CHECKLIST,
	requirement_ready: REQUIREMENT_READY_CHECKLIST,
	requirement_acceptance: REQUIREMENT_ACCEPTANCE_CHECKLIST,
	workflow_approval: WORKFLOW_APPROVAL_CHECKLIST,
	breakdown: BREAKDOWN_CHECKLIST,
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
