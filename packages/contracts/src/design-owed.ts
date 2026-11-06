// What a design owes a person past its own step (REQ-68 BC-5), said once for every reader: the
// pin-only changes its approval left its dependents (one act follows them all) and the places its
// code and design differ. Who settles those is the one rule's (`who-owes.ts:whoOwes`, `design.decide`,
// ISS-1068): reconciling code to an approved design is the master's, and a person's only where the
// project's designs gate asks one. Needs you lists each a person owes as a row on the design
// (`development/needs-you-design.ts`), and the design's page says the same wait in Where it stands
// (`workflows/design-standing.ts:designWaitingOn`), so the two never disagree: judge run d47d6de0 at
// dev.489 read "Waits on: Nobody · nothing next" beside "Needs you 2" and "Approve 4 pin-only changes".

import { say } from "./said.js";
import { type WaitingOn, waitingOn } from "./standing.js";

/** The pin-only dependents one re-pin act would move to follow the design's approved revision. */
export interface RepinOwed {
	/** The design they follow, by flow. */
	flow: string;
	/** Its approved revision, which they move to follow. */
	revision: number;
	/** How many dependents the act takes. */
	n: number;
}

/** What a design owes a person past its own step; nothing where both are empty. */
export interface DesignOwed {
	/** The design, by flow. */
	flow: string;
	repin: RepinOwed | null;
	/** The places its code and design differ, to be settled (`WorkflowHealth.needsYou`). */
	settle: number;
	/** Who settles them, by `whoOwes('design.decide')` over the project's policy. */
	settleBy: "person" | "master";
}

/** The re-pin a design's approver owes: "You" where the reader may take it, else its permission's holder. */
export function repinOwedWait(
	repin: RepinOwed,
	canDecide: boolean,
): WaitingOn<"you" | "person"> {
	const act = say("designs.act.repinBatch", {
		n: repin.n,
		changes: repin.n === 1 ? "change" : "changes",
		r: repin.revision,
	});
	const rule = say("designs.rule.repinBatch", {
		flow: repin.flow,
		r: repin.revision,
	});
	return canDecide
		? waitingOn("you", { who: say("standing.who.you"), act, rule })
		: waitingOn("person", {
				who: say("standing.who.holderOf", { perm: "workflow-designs.approve" }),
				act,
				rule,
			});
}

/**
 * The places the design's code and design differ, waiting on whoever the one rule names to settle
 * them. Every core reader passes `by`; a test fixture that names no project reads the person's wait.
 */
export function settleOwedWait(
	n: number,
	flow: string,
	by: "person" | "master" = "person",
): WaitingOn<"person" | "agent"> {
	const act = say("designs.act.settleMarkers", {
		n,
		places: n === 1 ? "place" : "places",
	});
	return by === "master"
		? waitingOn(
				"agent",
				{
					who: say("standing.who.master"),
					act,
					rule: say("designs.rule.masterSettles"),
				},
				{ ref: flow },
			)
		: waitingOn(
				"person",
				{
					who: say("designs.who.aPerson"),
					act,
					rule: say("designs.rule.needsYou"),
				},
				{ ref: flow },
			);
}

/** The wait a design owes past its step: the re-pin first, a one-press decision, then the places to decide. */
export function owedWait(
	owed: DesignOwed,
	canDecide: boolean,
): WaitingOn<"you" | "person" | "agent"> | null {
	if (owed.repin && owed.repin.n > 0)
		return repinOwedWait(owed.repin, canDecide);
	if (owed.settle > 0)
		return settleOwedWait(owed.settle, owed.flow, owed.settleBy);
	return null;
}
