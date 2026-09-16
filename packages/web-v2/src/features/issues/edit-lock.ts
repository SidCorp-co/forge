// Which of a person's edits the UI refuses while a drive job is live on the
// issue, in ONE place. Five surfaces render a control that job writes over —
// the status picker, the issues-list row overflow menu, the properties rail,
// the description card and the bulk bar — and until ISS-1010 only the first
// carried the rule, so the other four handed a person an edit the job replaced
// seconds later. That reads as the click not taking, which is the failure this
// predicate exists to remove.

import type { IssueAgentStatus, IssueStatus } from "./types";

// cm:guard `needs_info` is exempt from the lock and must stay exempt — it is the one park a person's answer restarts, so locking it greys out the only way forward on an issue whose session is still resident; everything else set while a drive job is live is written over by that job moments later, which reads as the edit silently not taking.
export const ANSWERABLE_WHILE_RUNNING = new Set<IssueStatus>(["needs_info"]);

// cm:guard only `running` locks. `queued` has dispatched nothing that can overwrite anything yet, and `failed` is what a DEFERRED RETRY reads as — core's `deriveAgentStatus` falls through to the most recent terminal session when nothing is running or queued (the ISS-903 shape). Locking either refuses a person on an issue no job is touching, which is the opposite failure and a worse one: the person has no way to tell it from a bug.
export function heldByAgent(
	status: IssueStatus,
	agentStatus: IssueAgentStatus | undefined,
): boolean {
	return agentStatus === "running" && !ANSWERABLE_WHILE_RUNNING.has(status);
}

/** How many of a selection a live job is holding — the bulk bar refuses on any
 *  and says the count, because "one of nine" and "nine of nine" are different
 *  re-selections for the person holding the mouse. */
export function heldInSelection(
	rows: { status: IssueStatus; agentStatus?: IssueAgentStatus }[],
): number {
	return rows.filter((r) => heldByAgent(r.status, r.agentStatus)).length;
}

/** Said in place of a status move. */
export const AGENT_HOLDS_MOVE =
	"An agent is working this — your move would be overwritten";

/** Said in place of a field edit. */
export const AGENT_HOLDS_EDIT =
	"An agent is working this — your edit would be overwritten";

/** Said in place of a bulk action, naming how much of the selection is held. */
export function agentHoldsSelection(held: number, total: number): string {
	return held === total
		? `An agent is working ${total === 1 ? "this issue" : `all ${total} selected issues`} — your change would be overwritten`
		: `An agent is working ${held} of the ${total} selected issues — your change would be overwritten`;
}
