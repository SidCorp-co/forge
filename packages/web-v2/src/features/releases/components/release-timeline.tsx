"use client";

// The release run as an ordered timeline — one entry per act, oldest first.

import { EmptyState } from "@/design";
import type { ReleaseAttempt } from "../types";
import { ReleaseAttemptEntry } from "./release-attempt-entry";

/**
 * Oldest first, by when the act was DECLARED and never by when it reported.
 *
 * `startedAt` is written before the act runs and `settledAt` after it, so
 * ordering on the settle time would put a deploy that took four minutes after
 * a verify that was declared later and answered instantly — a sequence that
 * never happened. Ties break on `id`, which is the tie-break
 * `listAttempts` uses in core, so the two orders cannot disagree.
 *
 * The sort is done here rather than trusted from the response because this
 * component's contract is that what it renders is in order: a caller holding a
 * list from anywhere else gets the same guarantee.
 */
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
}

export function ReleaseTimeline({ attempts }: ReleaseTimelineProps) {
	if (attempts.length === 0) {
		return (
			<EmptyState
				title="This run has recorded no acts"
				message="Nothing has been promoted, deployed or verified under this release run yet. An act is written down before it happens, so an empty timeline means the run has not started one."
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
