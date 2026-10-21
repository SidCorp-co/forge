
import type { IssueAgentStatus, IssueStatus } from "./types";

export const ANSWERABLE_WHILE_RUNNING = new Set<IssueStatus>(["needs_info"]);

export function heldByAgent(
	status: IssueStatus,
	agentStatus: IssueAgentStatus | undefined,
): boolean {
	return agentStatus === "running" && !ANSWERABLE_WHILE_RUNNING.has(status);
}

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

/** Said once on the issue page for Description and the rail alike (ISS-1228 r26), as of the issue's reading. */
export function agentHoldsIssue(asOfClock: string | null): string {
	return asOfClock
		? `As of ${asOfClock} an agent was working this issue, so an edit to its description or properties would be overwritten.`
		: "An agent is working this issue, so an edit to its description or properties now would be overwritten.";
}

/** Said in place of a bulk action, naming how much of the selection is held. */
export function agentHoldsSelection(held: number, total: number): string {
	return held === total
		? `An agent is working ${total === 1 ? "this issue" : total === 2 ? "both selected issues" : `all ${total} selected issues`} — your change would be overwritten`
		: `An agent is working ${held} of the ${total} selected issues — your change would be overwritten`;
}
