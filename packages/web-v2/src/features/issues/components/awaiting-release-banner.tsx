"use client";

import { Banner, Button } from "@/design";
import { formatCountdown, formatRelativeTime } from "@/lib/utils/format";
import { useBatchRelease, useReleaseRoster } from "../hooks";

/**
 * What "awaiting release" means, on the issue a person is actually reading:
 * it is merged, it is not shipped, and here is when that changes.
 */
// cm:guard the countdown must degrade honestly. No schedule prints "no schedule — waiting for a person", never a number: a person told their issue ships tonight, when nothing will cut it, is worse off than one told nobody scheduled a release.
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
		return <Banner tone="info">{`${merged} — a release is shipping it now`}</Banner>;
	}

	return (
		<Banner
			tone="info"
			action={
				canWrite ? (
					<Button
						size="sm"
						disabled={batch.isPending}
						onClick={() => batch.mutate({ issueIds: [issueId] })}
					>
						Release now
					</Button>
				) : undefined
			}
		>
			<span className="font-medium">{merged} — not shipped yet.</span>{" "}
			{data.nextCutAt
				? `The next release cut runs ${formatCountdown(data.nextCutAt)}.`
				: "No release is scheduled, so this ships when a person cuts one."}
		</Banner>
	);
}
