
import { Banner } from "@/design";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { useReleaseRoster } from "../hooks";

/**
 * What "awaiting release" means, on the issue a person is actually reading:
 * it is merged, it is not shipped, and here is when that changes. It releases nothing itself: a
 * person never works an issue (REQ-68 BC-6), and a release is cut on Releases or by its schedule.
 */
export function AwaitingReleaseBanner({
	projectId,
	issueId,
}: {
	projectId: string;
	issueId: string;
}) {
	const { data } = useReleaseRoster(projectId);
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
		<Banner tone="info">
			<span className="font-medium">{t("issues.awaiting.notShipped", { merged })}</span>{" "}
			{data.nextCutAt
				? t("issues.awaiting.nextCut", { when: time.countdown(data.nextCutAt) })
				: t("issues.awaiting.noCut")}
		</Banner>
	);
}
