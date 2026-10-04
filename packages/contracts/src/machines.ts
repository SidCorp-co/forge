// Every status machine, by the entity its moves are recorded under (`kernel_transitions.entity`).

import type { StatusMachine } from "./state-machine.js";
import { DEVICE_MACHINE, RUNNER_MACHINE, RUNNER_PROVISION_MACHINE } from "./runner-machine.js";
import { FEEDBACK_MACHINE } from "./feedback-machine.js";
import { ISSUE_MACHINE } from "./issue-machine.js";
import { JOB_MACHINE } from "./job-machine.js";
import { MOCKUP_MACHINE } from "./mockup-machine.js";
import { QUESTIONNAIRE_MACHINE } from "./onboarding-machine.js";
import { QUESTION_MACHINE } from "./question-machine.js";
import { RECONCILE_RUN_MACHINE } from "./reconcile-run-machine.js";
import { REQUIREMENT_MACHINE } from "./requirement-machine.js";
import { RUN_MACHINE } from "./run-machine.js";
import { SCHEDULE_RUN_MACHINE } from "./schedule-run-machine.js";
import { SESSION_MACHINE } from "./session-machine.js";
import { SUGGESTION_MACHINE } from "./suggestion-machine.js";

export const MACHINE_ENTITIES = [
	"issue",
	"job",
	"session",
	"run",
	"suggestion",
	"feedback",
	"requirement",
	"mockup",
	"questionnaire",
	"question",
	"schedule_run",
	"reconcile_run",
	"runner",
	"runner_provision",
	"device",
] as const;
export type MachineEntity = (typeof MACHINE_ENTITIES)[number];

export const MACHINES = {
	issue: ISSUE_MACHINE,
	job: JOB_MACHINE,
	session: SESSION_MACHINE,
	run: RUN_MACHINE,
	suggestion: SUGGESTION_MACHINE,
	feedback: FEEDBACK_MACHINE,
	requirement: REQUIREMENT_MACHINE,
	mockup: MOCKUP_MACHINE,
	questionnaire: QUESTIONNAIRE_MACHINE,
	question: QUESTION_MACHINE,
	schedule_run: SCHEDULE_RUN_MACHINE,
	reconcile_run: RECONCILE_RUN_MACHINE,
	runner: RUNNER_MACHINE,
	runner_provision: RUNNER_PROVISION_MACHINE,
	device: DEVICE_MACHINE,
} as const satisfies { readonly [E in MachineEntity]: StatusMachine<E> };

export type MachineOf<E extends MachineEntity> = (typeof MACHINES)[E];
export type StateOf<E extends MachineEntity> = MachineOf<E>["states"][number];
