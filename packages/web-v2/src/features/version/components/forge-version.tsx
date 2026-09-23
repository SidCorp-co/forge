"use client";

import { cn } from "@/lib/utils/cn";
import { useForgeVersion } from "../hooks";

/** The product's own version, for the footer of the shell navigation on screen. */
export function ForgeVersion({ className }: { className?: string }) {
	const query = useForgeVersion();

	if (query.isPending) return null;

	// A 200 with no version string reported none; "undefined" is not a version (ISS-1119).
	const raw = query.data?.version;
	const version = typeof raw === "string" ? raw.trim() : "";
	const label = version ? `Forge v${version}` : "Forge version unavailable";
	const commit = version ? query.data?.sourceCommit : null;

	return (
		<p
			className={cn("text-muted", className)}
			title={commit == null ? label : `${label} · ${commit.slice(0, 7)}`}
		>
			{label}
		</p>
	);
}
