"use client";

// The release run as an ordered timeline — one entry per act, oldest first.

import { EmptyState } from "@/design";
import type { ReleaseAttempt } from "../types";
import { ReleaseAttemptEntry } from "./release-attempt-entry";

function byBytes(a: string, b: string): number {
	if (a < b) return -1;
	return a > b ? 1 : 0;
}

export function orderAttempts(attempts: ReleaseAttempt[]): ReleaseAttempt[] {
	return [...attempts].sort((a, b) => {
		const byStart = byBytes(a.startedAt, b.startedAt);
		return byStart !== 0 ? byStart : byBytes(a.id, b.id);
	});
}

export interface ReleaseTimelineProps {
	attempts: ReleaseAttempt[];
	/** The run has ended, so an empty timeline is what it did rather than what it has not done yet. */
	ended: boolean;
}

export function ReleaseTimeline({ attempts, ended }: ReleaseTimelineProps) {
	if (attempts.length === 0) {
		return (
			<EmptyState
				title={ended ? "This run recorded no acts" : "This run has recorded no acts"}
				message={
					ended
						? "Nothing was promoted, deployed or verified under this release run before it ended. An act is written down before it happens, so the run took none."
						: "Nothing has been promoted, deployed or verified under this release run yet. An act is written down before it happens, so an empty timeline means the run has not started one."
				}
			/>
		);
	}

	return (
		<ol
			className="flex flex-col gap-5 border-l border-line-subtle pl-1"
			data-testid="release-timeline"
		>
			{orderAttempts(attempts).map((attempt) => (
				<ReleaseAttemptEntry key={attempt.id} attempt={attempt} />
			))}
		</ol>
	);
}
