"use client";

import { Banner } from "@/design";
import { PROVISION_LABEL, type ProjectRunner } from "../types";

/** "47 minutes", "2 hours", "9 days": the unit a person would say it in. */
export function stalledFor(seconds: number): string {
	const [n, unit] =
		seconds < 3600
			? [Math.max(1, Math.round(seconds / 60)), "minute"]
			: seconds < 172_800
				? [Math.round(seconds / 3600), "hour"]
				: [Math.round(seconds / 86_400), "day"];
	return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/**
 * A provision past core's stall window (ISS-1359): `cloning` alone reads the same for a clone
 * running now and one that died. It says how long, and whether the box is serving the project.
 */
export function ProvisionStalledBanner({ runner }: { runner: ProjectRunner }) {
	const seconds = runner.provisionStalledSeconds;
	if (seconds === null || seconds === undefined || runner.provisionStatus === null) return null;
	return (
		<Banner tone="attention">
			<span className="font-semibold">Stalled.</span> It has stood at{" "}
			{PROVISION_LABEL[runner.provisionStatus]} for {stalledFor(seconds)} with no report from the
			box, so it is not in progress.{" "}
			{runner.residentMaster === undefined
				? ""
				: runner.residentMaster
					? "This box is running the project's master from the workspace, so the stalled provision does not hold it back by itself; Re-provision is refused while that master runs."
					: "The box re-runs it on its next sweep once it is polling again, or use Re-provision."}
		</Banner>
	);
}
