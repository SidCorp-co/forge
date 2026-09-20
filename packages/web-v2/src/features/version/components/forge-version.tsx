"use client";

import { cn } from "@/lib/utils/cn";
import { useForgeVersion } from "../hooks";

export interface ForgeVersionProps {
	/** `compact` drops the word "Forge", for the 60px icon rail. */
	variant?: "full" | "compact";
	className?: string;
}

/**
 * The product's own version, in the one place the product identifies itself: the
 * footer of whichever shell navigation is on screen. The shell draws one of the
 * three at a time, so this node goes to all of them and never shows twice.
 */
export function ForgeVersion({ variant = "full", className }: ForgeVersionProps) {
	const query = useForgeVersion();

	// A version not yet fetched is not a version the deployment failed to report.
	if (query.isPending) return null;

	const deployment = query.data ?? null;
	const spoken = deployment ? `Forge v${deployment.version}` : "Forge version unavailable";
	const shown = deployment
		? variant === "compact"
			? `v${deployment.version}`
			: `Forge v${deployment.version}`
		: "version unavailable";
	const title =
		deployment?.sourceCommit != null
			? `${spoken} · ${deployment.sourceCommit.slice(0, 7)}`
			: spoken;

	return (
		<p className={cn("fg-caption truncate text-muted", className)} title={title}>
			{shown === spoken ? (
				shown
			) : (
				<>
					<span className="sr-only">{spoken}</span>
					<span aria-hidden="true">{shown}</span>
				</>
			)}
		</p>
	);
}
