
import type { Copy } from "@/lib/i18n/product-copy";
import type { IssueAgentStatus, IssueStatus } from "./types";

const ANSWERABLE_WHILE_RUNNING = new Set<IssueStatus>(["needs_info"]);

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
export const agentHoldsMove = (t: Copy): string => t("issues.lock.move");

/** Said in place of a field edit. */
export const agentHoldsEdit = (t: Copy): string => t("issues.lock.edit");

/** Said in place of a bulk action, naming how much of the selection is held. */
export function agentHoldsSelection(t: Copy, held: number, total: number): string {
	if (held !== total) return t("issues.lock.someSelected", { held, total });
	return total === 1 ? t("issues.lock.oneSelected") : t("issues.lock.allSelected", { total });
}
