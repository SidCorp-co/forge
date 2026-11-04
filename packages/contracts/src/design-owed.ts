// What a design owes a person past its own step (REQ-68 BC-5), said once for every reader: the
// pin-only changes its approval left its dependents (one act follows them all) and the places its
// code and design differ that a person decides. Needs you lists each as a row on the design
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
	/** The places its code and design differ that a person decides (`WorkflowHealth.needsYou`). */
	settle: number;
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

/** The places a person decides where the design's code and design differ. */
export function settleOwedWait(n: number, flow: string): WaitingOn<"person"> {
	return waitingOn(
		"person",
		{
			who: say("designs.who.aPerson"),
			act: say("designs.act.settleMarkers", {
				n,
				places: n === 1 ? "place" : "places",
			}),
			rule: say("designs.rule.needsYou"),
		},
		{ ref: flow },
	);
}

/** The wait a design owes past its step: the re-pin first, a one-press decision, then the places to decide. */
export function owedWait(
	owed: DesignOwed,
	canDecide: boolean,
): WaitingOn<"you" | "person"> | null {
	if (owed.repin && owed.repin.n > 0)
		return repinOwedWait(owed.repin, canDecide);
	if (owed.settle > 0) return settleOwedWait(owed.settle, owed.flow);
	return null;
}
