"use client";

import { Banner, Button } from "@/design";
import { useBatchRelease, useReleaseRoster } from "../hooks";

function countdown(iso: string | null): string {
	if (!iso) return "";
	const ms = new Date(iso).getTime() - Date.now();
	if (Number.isNaN(ms)) return "";
	if (ms <= 0) return "any moment now";
	const hours = Math.floor(ms / 3_600_000);
	if (hours < 1) return `in ${Math.max(1, Math.round(ms / 60_000))} min`;
	if (hours < 48) return `in ${hours}h`;
	return `in ${Math.ceil(ms / 86_400_000)} days`;
}

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

	const merged =
		entry.waitingDays == null
			? "Merged"
			: entry.waitingDays === 0
				? `Merged into ${baseBranch ?? "the base branch"} today`
				: `Merged into ${baseBranch ?? "the base branch"} ${entry.waitingDays} day${entry.waitingDays === 1 ? "" : "s"} ago`;

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
				? `The next release cut runs ${countdown(data.nextCutAt)}.`
				: "No release is scheduled, so this ships when a person cuts one."}
		</Banner>
	);
}
