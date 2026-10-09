// Where a person must agree or approve (REQ-34 r2 BC-25; Requirement lifecycle r15 design_check,
// ready_check, rev_check, breakdown_check, acceptance_check; Issue lifecycle r15 ready-check): one switch per
// step in the project document's `approvals`, every one off by default. Off, the step's checklist
// decides and whoever may write the item takes the move; on, the move waits on a holder of the
// step's approve permission. Who that is follows the permission vocabulary (ADR 0007): a person or
// an agent holding it alike. Release approval keeps its own switch, `release.approval.required`.

import { z } from "zod";
import type { ProjectPermission } from "./permissions.js";

export const PERSON_GATES = ["agree", "revisions", "breakdown", "admit", "accept", "designs"] as const;
export type PersonGate = (typeof PERSON_GATES)[number];

export interface PersonGateDeclaration {
	/** The step as a person reads it. */
	readonly label: string;
	/** Who the move needs where the switch is on. */
	readonly on: ProjectPermission;
	/** Who the move needs where it is off: whoever may write the item. */
	readonly off: ProjectPermission;
}

export const PERSON_GATE_STEPS: Readonly<Record<PersonGate, PersonGateDeclaration>> = {
	agree: { label: "agreeing a requirement", on: "requirements.approve", off: "project.write" },
	revisions: { label: "accepting a requirement revision", on: "requirements.approve", off: "project.write" },
	breakdown: { label: "accepting a breakdown", on: "suggestions.approve", off: "suggestions.write" },
	admit: { label: "admitting an issue to open", on: "issues.admit", off: "project.write" },
	accept: { label: "accepting a delivered requirement", on: "requirements.approve", off: "project.write" },
	designs: { label: "approving a workflow design", on: "workflow-designs.approve", off: "workflow-designs.write" },
};

/** The project document's `approvals`: a step absent or false needs no person. */
export const approvalsSchema = z.strictObject(
	Object.fromEntries(PERSON_GATES.map((g) => [g, z.boolean().optional()])) as Record<
		PersonGate,
		z.ZodOptional<z.ZodBoolean>
	>,
);
export type Approvals = z.infer<typeof approvalsSchema>;

export const personGateOn = (
	approvals: Approvals | null | undefined,
	gate: PersonGate,
): boolean => approvals?.[gate] === true;

/** The permission the step's move asks of its mover, as the project's switch stands. */
export function personGatePermission(
	approvals: Approvals | null | undefined,
	gate: PersonGate,
): ProjectPermission {
	const step = PERSON_GATE_STEPS[gate];
	return personGateOn(approvals, gate) ? step.on : step.off;
}

/** The act a refusal names, saying why the approve permission is asked where the switch is on. */
export function personGateAct(approvals: Approvals | null | undefined, gate: PersonGate): string {
	const step = PERSON_GATE_STEPS[gate];
	return personGateOn(approvals, gate)
		? `${step.label}, which this project asks a holder of ${step.on} to do (its approvals.${gate} setting is on),`
		: step.label;
}
