"use client";

import { Banner, Button } from "@/design";
import { formatCountdown, formatRelativeTime } from "@/lib/utils/format";
import { failedCloseLead } from "@/features/releases/roster";
import { useBatchRelease, useReleaseRoster } from "../hooks";

/**
 * What "awaiting release" means, on the issue a person is actually reading:
 * it is merged, it is not shipped, and here is when that changes.
 */
export function AwaitingReleaseBanner({
	projectId,
	issueId,
	canWrite,
}: {
	projectId: string;
	issueId: string;
	canWrite: boolean;
}) {
	const { data } = useReleaseRoster(projectId);
	const batch = useBatchRelease(projectId);

	const entry = data?.issues.find((i) => i.id === issueId);
	if (!data?.gateStatus || !entry) return null;
	const baseBranch = data.baseBranch;

	const merged = entry.mergedAt
		? `Merged into ${baseBranch ?? "the base branch"} ${formatRelativeTime(entry.mergedAt)}`
		: "Merged";

	if (entry.claimedByRunId) {
		return <Banner tone="info">{`${merged} — it is in a release, whose run says whether a box has started it`}</Banner>;
	}

	// A release would hand this issue straight back, so it offers none and says what clears it (ISS-1337).
	if (entry.closeRefusals.length > 0) {
		return (
			<Banner tone="attention">
				<span className="font-medium">A release could not close this issue yet:</span>{" "}
				{entry.closeRefusals.map((r) => `${r.reason}. ${r.clears}`).join(" ")}
			</Banner>
		);
	}

	const action = canWrite ? (
		<Button size="sm" disabled={batch.isPending} onClick={() => batch.mutate({ issueIds: [issueId] })}>
			Release now
		</Button>
	) : undefined;

	// Nothing here reads when that fault is fixed, so Release now stays and says what it meets (ISS-1381 r4).
	if (entry.closeFailure) {
		return (
			<Banner tone="attention" action={action}>
				<span className="font-medium">{failedCloseLead(entry.closeFailure, "this issue")}</span>{" "}
				Release now fails the same way until whoever operates Forge fixes it.
			</Banner>
		);
	}

	return (
		<Banner tone="info" action={action}>
			<span className="font-medium">{merged} — not shipped yet.</span>{" "}
			{data.nextCutAt
				? `The next release cut runs ${formatCountdown(data.nextCutAt)}.`
				: "No release is scheduled, so this ships when a person cuts one."}
		</Banner>
	);
}
