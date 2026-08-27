"use client";

// Toasts for the two dependency-unblock events (ISS-64, ISS-40 PR-E).
//
// `issue.unblockCascade` fires once per blocker that went terminal, naming the
// dependents it released; `dependency.unblocked` fires when one of those
// actually dispatches. Neither is persisted, so this is a confirmation the
// cascade fired, not a record of it — the record is a comment on each
// dependent, written by core.

import { useEffect } from "react";
import { wsClient } from "@/lib/ws/client";
import { useToast } from "@/providers/toast-provider";

interface CascadeDependent {
	issueId: string;
	issSeq: number;
}

interface UnblockCascadePayload {
	blockerId: string;
	blockerIssSeq: number | null;
	dependents: CascadeDependent[];
	overflow: number;
}

export function describeCascade(d: UnblockCascadePayload): string {
	const names = d.dependents.map((x) => `ISS-${x.issSeq}`);
	const shown = names.join(", ");
	return d.overflow > 0 ? `${shown} +${d.overflow} more` : shown;
}

/**
 * Mounted once in the workspace layout. Without it these two events reach a
 * no-op branch of the event router, which is where they sat while a comment
 * named a consumer file that did not exist.
 */
export function useUnblockCascadeToasts(): void {
	const { toast } = useToast();

	useEffect(() => {
		return wsClient.on((env) => {
			if (env.event !== "issue.unblockCascade") return;
			const d = env.data as UnblockCascadePayload;
			if (!d || !Array.isArray(d.dependents) || d.dependents.length === 0) return;
			const blocker = d.blockerIssSeq ? `ISS-${d.blockerIssSeq}` : "A blocker";
			toast({
				title: `${blocker} released ${d.dependents.length} issue${d.dependents.length === 1 ? "" : "s"}`,
				description: describeCascade(d),
				tone: "info",
			});
		});
	}, [toast]);
}
