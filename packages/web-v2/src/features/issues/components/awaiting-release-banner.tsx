"use client";

import { Banner, Button } from "@/design";
import { formatCountdown, formatRelativeTime } from "@/lib/utils/format";
import { unbrokenKeys } from "@/lib/unbroken-keys";
import { CloseFailureTechnical } from "@/features/releases/components/close-failure-technical";
import { failedCloseLead } from "@/features/releases/roster";
import { useBatchRelease, useReleaseRoster } from "../hooks";
import { askWhoReleases as askWho } from "../release-who";
import type { MergeMarkKind } from "../types";

/** A claim, by the commit it names: one the repository holds, one nobody checked, or none. */
function claimedAs(when: string, held?: string | null, unchecked?: string | null): string {
	if (held) return `Claimed as merged at ${held.slice(0, 7)}${when}, a commit the repository holds`;
	if (unchecked) return `Claimed as merged at ${unchecked.slice(0, 7)}${when}, not checked against the repository`;
	return `Claimed as merged${when}, naming no commit`;
}

/** When a waiting issue goes out, where no cut is scheduled: the help quotes both (ISS-1421 r40). */
export const RELEASES_ITSELF = "Forge releases it on its own once its criteria pass and nothing holds it.";
export const NO_SCHEDULE = "No release is scheduled, so this goes out when a person cuts one.";

/**
 * What "awaiting release" means, on the issue a person is actually reading:
 * it is merged, it is not released, and here is when that changes.
 */
export function AwaitingReleaseBanner({
	projectId,
	issueId,
	canRelease,
	askWhoReleases = false,
	mergeMark,
	mergedCommitSha,
	mergedClaimedCommit,
}: {
	projectId: string;
	issueId: string;
	/** The release door takes a project admin, so Release now is offered to one alone (ISS-1300 r5). */
	canRelease: boolean;
	/** Where the reader may not release: name who may, in place of a button that would be refused. */
	askWhoReleases?: boolean;
	/** Which record the mark is: a claim naming no commit is never said to be a merge (ISS-1421 r14). */
	mergeMark?: MergeMarkKind;
	/** The commit a person's mark names, checked against the repository (ISS-1300 r3). */
	mergedCommitSha?: string | null;
	/** A commit a claim names that Forge could not check, as the properties rail says it. */
	mergedClaimedCommit?: string | null;
}) {
	const { data } = useReleaseRoster(projectId);
	const batch = useBatchRelease(projectId);

	const entry = data?.issues.find((i) => i.id === issueId);
	if (!data?.gateStatus || !entry) return null;
	const baseBranch = data.baseBranch;

	const when = entry.mergedAt ? ` ${formatRelativeTime(entry.mergedAt)}` : "";
	const merged =
		mergeMark === "asserted"
			? claimedAs(when, mergedCommitSha, mergedClaimedCommit)
			: mergeMark === "landed"
				? `Marked as landed${when}`
				: entry.mergedAt
					? `Merged into ${baseBranch ?? "the base branch"}${when}`
					: "Merged";

	if (entry.claimedByRunId) {
		return <Banner tone="info">{`${merged} — it is in a release, whose run says whether a box has started it`}</Banner>;
	}

	// A release would hand this issue straight back, or Release now would be refused, so it offers none
	// and says what is missing and what clears it (ISS-1337): one line per shortfall, each naming its
	// door on this page (ISS-1421), and every reason no pick escapes (ISS-1421 r37).
	const missing = [
		...[...entry.closeRefusals, ...entry.releaseRefusals].map((r) => ({ key: r.code, said: r.saidHere })),
		...data.blockingAll.map((b) => ({ key: `all-${b.code}`, said: b.said })),
	];
	if (missing.length > 0) {
		return (
			<Banner tone="attention">
				<p className="font-medium">Not ready to release.</p>
				<ul className="mt-1 flex flex-col gap-1" aria-label="What is missing">
					{missing.map((m) => (
						<li key={m.key}>{unbrokenKeys(m.said)}</li>
					))}
				</ul>
			</Banner>
		);
	}

	const action = canRelease ? (
		<Button variant="primary" size="sm" disabled={batch.isPending} onClick={() => batch.mutate({ issueIds: [issueId] })}>
			Release now
		</Button>
	) : undefined;

	// Nothing here reads when that fault is fixed, so Release now stays and says what it meets (ISS-1381 r4).
	if (entry.closeFailure) {
		return (
			<Banner tone="attention" action={action}>
				<span className="font-medium">{failedCloseLead(entry.closeFailure, "this issue")}</span>{" "}
				Release now fails the same way until whoever operates Forge fixes it.
				{askWhoReleases && ` ${askWho("it")}`}
				<CloseFailureTechnical failure={entry.closeFailure} />
			</Banner>
		);
	}

	return (
		<Banner tone="info" action={action}>
			<span className="font-medium">{merged} — not released yet.</span>{" "}
			{data.nextCutAt
				? `The next release cut runs ${formatCountdown(data.nextCutAt)}.`
				: data.automaticRelease
					? RELEASES_ITSELF
					: NO_SCHEDULE}
			{askWhoReleases && ` ${askWho("it")}`}
		</Banner>
	);
}
