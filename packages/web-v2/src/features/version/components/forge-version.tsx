"use client";

import { cn } from "@/lib/utils/cn";
import { useForgeVersion } from "../hooks";

/** The product's own version, for the footer of the shell navigation on screen. */
export function ForgeVersion({ className }: { className?: string }) {
	const query = useForgeVersion();

	// Not yet fetched is not the same as not reported: nothing stands in for it.
	if (query.isPending) return null;

	const deployment = query.data ?? null;
	const label = deployment ? `Forge v${deployment.version}` : "Forge version unavailable";
	const commit = deployment?.sourceCommit;

	return (
		<p
			className={cn("text-muted", className)}
			title={commit == null ? label : `${label} · ${commit.slice(0, 7)}`}
		>
			{label}
		</p>
	);
}
