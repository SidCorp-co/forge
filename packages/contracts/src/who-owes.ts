// Who owes an act (ISS-1058; owner 2026-10-31, 2026-11-07; REQ-79 BC-11 to BC-14, REQ-68 BC-3): the
// one table every surface that names an act's owner reads. An owed act names a person only where it
// is serious: irreversible, real money, credentials or product direction. Every other act is the
// project's master's: it is admissible work a master is placed for, and it is never in a person's
// Needs you. The one exception is the project's own policy ("humans set policy"): where the project
// turned a person's gate on, by its gate profile (`strict`), a person gate (`approvals`, as the
// profile resolves it) or `release.approval.required`, that act stays a person's. An act whose
// seriousness depends on what it carries (a release carrying a change that cannot be undone) reads
// that content here too, never at a surface.
//
// The release standing (`release-batch/release-view.ts`, `release-gates.ts`), Needs you
// (`development/needs-you-agent-takes.ts`), the feedback standing (`feedback/standing.ts`), the
// forecast's release leg and the master's owed work all ask `whoOwes`; none decides "who" itself.

import {
	DECISION_ACT_OF_SAID,
	type DecisionAct,
} from "./needs-you-decisions.js";
import type { PersonGate } from "./person-gates.js";

/** Why an act is serious: what a person alone may decide (VISION; owner 2026-10-31). */
export const SERIOUS_BECAUSE = [
	"irreversible",
	"money",
	"credentials",
	"direction",
	/** a question its asker judged serious, which the ask door alone lets reach a person (`questions/owed.ts`) */
	"asked",
] as const;
export type SeriousBecause = (typeof SERIOUS_BECAUSE)[number];

/**
 * The serious classes as one phrase, what a refusal names: the ask door's (`questions/owed.ts`) and
 * every other reader's, so the classes a question is judged by are the ones an act is.
 */
export const SERIOUS =
	"irreversible, real money, credentials or product direction";

/** A switch of the project's own policy that keeps a routine act a person's while it is on. */
export type OwedPolicySwitch =
	/** the project asked for control: `gates.profile` is `strict` */
	| { kind: "strict" }
	/** a person gate in `approvals`, as the gate profile resolves it (`person-gates.ts:effectiveApprovals`) */
	| { kind: "gate"; gate: PersonGate }
	/** `release.approval.required` of the project document */
	| { kind: "release_approval" };

export type OwedActRule =
	| { serious: true; because: SeriousBecause; why: string }
	| {
			serious: false;
			why: string;
			/** The policy switches any of which, on, keep the act a person's. */
			personWhen: readonly OwedPolicySwitch[];
			/** The act turns serious where what it carries cannot be undone (`OwedContent.irreversible`). */
			byContent?: true;
	  };

/** The acts no decision button carries as its own act: a breakdown's accept, and the release acts owed at the gate or after a landing. */
export const OTHER_OWED_ACTS = [
	/** a suggestion accepted as a requirement's breakdown, which follows the breakdown gate (`suggestions/accept-gate.ts`) */
	"breakdown.accept",
	"release.record",
	"release.split",
	"release.settleClaim",
	"release.cutAndApprove",
	"release.setup",
] as const;
export type OtherOwedAct = (typeof OTHER_OWED_ACTS)[number];

/** Every act an owner is named for: each decision a button takes, and each release act none does. */
export type OwedActKind = DecisionAct | OtherOwedAct;

const STRICT: OwedPolicySwitch = { kind: "strict" };
const RELEASE_APPROVAL: OwedPolicySwitch = { kind: "release_approval" };
const gate = (g: PersonGate): OwedPolicySwitch => ({ kind: "gate", gate: g });

const ROUTINE_REQUIREMENT =
	"signing a requirement off is the master's outside strict (REQ-79 r6 BC-11): it holds requirements.approve there";
const ROUTINE_DESIGN =
	"approving a workflow design is the master's unless the project's designs gate asks a person";
const ROUTINE_CUT =
	"cutting a release that carries only reversible changes is delivery, which the master runs";

/**
 * The one table: every act kind, serious or routine, and why. A routine act names the switches of
 * the project's policy that keep it a person's.
 */
export const OWED_ACTS: Readonly<Record<OwedActKind, OwedActRule>> = {
	"question.answer": {
		serious: true,
		because: "asked",
		why: "a question reaches a person only where its asker judged it serious or a project rule names the person's act; the ask door refuses any other (`questions/owed.ts`, REQ-79 BC-14)",
	},
	"revision.accept": {
		serious: false,
		why: ROUTINE_REQUIREMENT,
		personWhen: [gate("revisions")],
	},
	"revision.return": {
		serious: false,
		why: ROUTINE_REQUIREMENT,
		personWhen: [STRICT],
	},
	"requirement.agree": {
		serious: false,
		why: ROUTINE_REQUIREMENT,
		personWhen: [gate("agree")],
	},
	"requirement.accept": {
		serious: false,
		why: ROUTINE_REQUIREMENT,
		personWhen: [gate("accept")],
	},
	"requirement.drop": {
		serious: false,
		why: ROUTINE_REQUIREMENT,
		personWhen: [STRICT],
	},
	"requirement.repin": {
		serious: false,
		why: ROUTINE_REQUIREMENT,
		personWhen: [gate("revisions")],
	},
	"requirement.defer": {
		serious: false,
		why: ROUTINE_REQUIREMENT,
		personWhen: [STRICT],
	},
	"suggestion.accept": {
		serious: false,
		why: "accepting a suggestion the agents wrote is the master's; a breakdown follows its own gate",
		personWhen: [STRICT],
	},
	"breakdown.accept": {
		serious: false,
		why: "accepting the agents' breakdown of an agreed requirement is planning, which the master does unless the breakdown gate asks a person",
		personWhen: [gate("breakdown")],
	},
	"suggestion.reject": {
		serious: false,
		why: "declining a suggestion the agents wrote is the master's",
		personWhen: [STRICT],
	},
	"feedback.verify": {
		serious: false,
		why: "confirming that an answer or a fix holds is a check on the running product, which the master makes and records; the reporter may still reopen",
		personWhen: [STRICT],
	},
	"feedback.reopen": {
		serious: false,
		why: "reopening a report its check found unsettled is the master's",
		personWhen: [STRICT],
	},
	"release.cut": {
		serious: false,
		why: ROUTINE_CUT,
		personWhen: [STRICT],
		byContent: true,
	},
	"release.decide": {
		serious: false,
		why: "approving a release that carries only reversible changes is delivery; a project that requires a person's release approval keeps it theirs",
		personWhen: [STRICT, RELEASE_APPROVAL],
		byContent: true,
	},
	"preview.approve": {
		serious: false,
		why: "approving a preview of the agents' own change is delivery",
		personWhen: [STRICT],
	},
	"design.decide": {
		serious: false,
		why: ROUTINE_DESIGN,
		personWhen: [gate("designs")],
	},
	"design.repin": {
		serious: false,
		why: ROUTINE_DESIGN,
		personWhen: [gate("designs")],
	},
	"contract.decide": {
		serious: false,
		why: "approving the project's own contract version is the master's outside strict (REQ-79 r6 BC-11): it holds contracts.approve there",
		personWhen: [STRICT],
	},
	"mockup.accept": {
		serious: false,
		why: "accepting a mockup of the agents' own work is a design approval, the master's unless the project's designs gate asks a person",
		personWhen: [gate("designs")],
	},
	"mockup.return": {
		serious: false,
		why: "returning a mockup of the agents' own work is a design approval, the master's unless the project's designs gate asks a person",
		personWhen: [gate("designs")],
	},
	"release.record": {
		serious: false,
		why: "recording a landing as the delivery is bookkeeping on what already landed, which the master's record door takes outside strict (REQ-79 r6 BC-17)",
		personWhen: [STRICT],
		byContent: true,
	},
	"release.split": {
		serious: false,
		why: "splitting a release over the roster cap into smaller ones is cutting releases, which the master does",
		personWhen: [STRICT],
		byContent: true,
	},
	"release.settleClaim": {
		serious: false,
		why: "waiting out or settling another writer's claim on the roster is delivery",
		personWhen: [STRICT],
	},
	"release.cutAndApprove": {
		serious: false,
		why: "cutting and approving a release of change requests is delivery, unless the project requires a person's release approval",
		personWhen: [STRICT, RELEASE_APPROVAL],
		byContent: true,
	},
	"release.setup": {
		serious: true,
		because: "credentials",
		why: "the project's production target, boxes and host access are credentials and machines a person holds and pays for",
	},
};

/** The project's policy as `whoOwes` reads it, read once per project (`development/who-owes-read.ts`). */
export interface OwedPolicy {
	strict: boolean;
	/** Each person gate as the gate profile resolves it (`person-gates.ts:effectiveApprovals`). */
	gates: Readonly<Record<PersonGate, boolean>>;
	/** `release.approval.required`. */
	releaseApproval: boolean;
}

/** What an act carries, where its seriousness depends on it. */
export interface OwedContent {
	/** What it carries that cannot be undone, as each change's release note says (`ReleaseNotes.irreversible`). */
	irreversible: readonly string[];
}

export type OwedBy =
	| { by: "person"; because: SeriousBecause | "policy"; why: string }
	| { by: "master"; why: string };

const switchOn = (s: OwedPolicySwitch, p: OwedPolicy): boolean => {
	switch (s.kind) {
		case "strict":
			return p.strict;
		case "gate":
			return p.gates[s.gate];
		case "release_approval":
			return p.releaseApproval;
	}
};

const SWITCH_SAID: Record<
	OwedPolicySwitch["kind"],
	(s: OwedPolicySwitch) => string
> = {
	strict: () => "this project is strict (gates.profile)",
	gate: (s) =>
		`this project's ${(s as { gate: PersonGate }).gate} gate asks a person (approvals)`,
	release_approval: () =>
		"this project requires a person's release approval (release.approval.required)",
};

/**
 * Who owes an act: a person where it is serious, by its kind or by what it carries, or where the
 * project's policy keeps it a person's; the project's master otherwise. Whether a master stands now
 * is not asked: a routine act is the master's, and a project owing one gets a master placed for it.
 */
export function whoOwes(
	kind: OwedActKind,
	policy: OwedPolicy,
	content?: OwedContent | null,
): OwedBy {
	const rule = OWED_ACTS[kind];
	if (rule.serious)
		return { by: "person", because: rule.because, why: rule.why };
	const irreversible = rule.byContent ? (content?.irreversible ?? []) : [];
	if (irreversible.length > 0) {
		return {
			by: "person",
			because: "irreversible",
			why: `it carries what cannot be undone: ${irreversible.join("; ")}`,
		};
	}
	const on = rule.personWhen.find((s) => switchOn(s, policy));
	if (on)
		return { by: "person", because: "policy", why: SWITCH_SAID[on.kind](on) };
	return { by: "master", why: rule.why };
}

/** The said act keys of the release acts no decision carries, by their kind. */
const RELEASE_SAID: Readonly<Record<string, OwedActKind>> = {
	"standing.act.cut": "release.cut",
	"standing.act.cutCarrierRelease": "release.cut",
	"standing.act.approve": "release.decide",
	"standing.act.reviewAndPromote": "release.decide",
	"standing.act.approveReleaseV": "release.decide",
	"standing.act.approveCarrierRelease": "release.decide",
	"issues.standing.act.approveOnReleases": "release.decide",
	"standing.act.recordLanding": "release.record",
	"standing.act.recordRelease": "release.record",
	"standing.act.releaseByHand": "release.record",
	"standing.act.releaseItByHand": "release.record",
	"standing.act.splitRelease": "release.split",
	"standing.act.cutWaiting": "release.settleClaim",
	"standing.act.cutAndApprove": "release.cutAndApprove",
	"standing.act.cutThenApprove": "release.cutAndApprove",
	"forecast.act.cutNextThenApprove": "release.cutAndApprove",
	"forecast.act.cutNext": "release.cut",
	"standing.act.declareTarget": "release.setup",
	"standing.act.reviveGateCheck": "release.setup",
	"standing.act.restoreHostRead": "release.setup",
	"standing.act.declareProbe": "release.setup",
	"standing.act.pairRunner": "release.setup",
	"standing.act.runnerOnline": "release.setup",
	"standing.act.productionReadable": "release.setup",
	"standing.act.labelRunner": "release.setup",
	"standing.act.sayIfGone": "feedback.verify",
};

/** The act kind a decision's act is, read with the page group a breakdown is accepted under. */
export function owedActOfDecision(
	act: DecisionAct,
	topic?: string | null,
): OwedActKind {
	return act === "suggestion.accept" && topic === "breakdown"
		? "breakdown.accept"
		: act;
}

/** The act kind a said act key names, or null where it names none an owner is asked for here. */
export function owedActOfSaid(key: string): OwedActKind | null {
	const released = RELEASE_SAID[key];
	if (released) return released;
	const decided = DECISION_ACT_OF_SAID[key];
	return decided ? owedActOfDecision(decided.act, decided.topic) : null;
}
