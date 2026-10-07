"use client";

import { Banner, Button } from "@/design";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
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
	const t = useCopy();
	const time = useTimeFormat();

	const entry = data?.issues.find((i) => i.id === issueId);
	if (!data?.gateStatus || !entry) return null;
	const baseBranch = data.baseBranch;

	const merged = entry.mergedAt
		? t("issues.awaiting.mergedInto", { branch: baseBranch ?? t("issues.awaiting.baseBranch"), at: time.relative(entry.mergedAt) })
		: t("issues.rail.merged");

	if (entry.claimedByRunId) {
		return <Banner tone="info">{t("issues.awaiting.shipping", { merged })}</Banner>;
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
						{t("issues.batch.releaseNow")}
					</Button>
				) : undefined
			}
		>
			<span className="font-medium">{t("issues.awaiting.notShipped", { merged })}</span>{" "}
			{data.nextCutAt
				? t("issues.awaiting.nextCut", { when: time.countdown(data.nextCutAt) })
				: t("issues.awaiting.noCut")}
		</Banner>
	);
}
