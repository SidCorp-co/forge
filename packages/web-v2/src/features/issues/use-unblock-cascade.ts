"use client";


import { useEffect } from "react";
import { wsClient } from "@/lib/ws/client";
import { useToast } from "@/providers/toast-provider";

interface CascadeDependent {
	issueId: string;
	issSeq: number;
	displayId: string;
}

interface UnblockCascadePayload {
	blockerId: string;
	blockerIssSeq: number | null;
	/** Named by the server: only it knows the project's issue prefix (ISS-992). */
	blockerDisplayId: string | null;
	dependents: CascadeDependent[];
	overflow: number;
}

export function describeCascade(d: UnblockCascadePayload): string {
	const names = d.dependents.map((x) => x.displayId);
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
			const blocker = d.blockerDisplayId ?? "A blocker";
			toast({
				title: `${blocker} released ${d.dependents.length} issue${d.dependents.length === 1 ? "" : "s"}`,
				description: describeCascade(d),
				tone: "info",
			});
		});
	}, [toast]);
}
