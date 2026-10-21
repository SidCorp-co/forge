"use client";

import { useEffect, useRef } from "react";
import { ApiError } from "./client";

export interface PageRead {
	isError: boolean;
	error: unknown;
	refetch: (options?: { cancelRefetch?: boolean }) => unknown;
}

function refusedAccess(read: PageRead): boolean {
	return read.isError && read.error instanceof ApiError && read.error.status === 403;
}

/** Access comes back for a whole page: once one 403 answers, every read still refused 403 is asked again (ISS-1228 r27). */
export function useAskAgainWhenAccessReturns(reads: readonly PageRead[]): void {
	const refusedBefore = useRef<ReadonlySet<number>>(new Set());
	const refusedNow = reads.flatMap((read, i) => (refusedAccess(read) ? [i] : []));
	const key = refusedNow.join(",");

	// biome-ignore lint/correctness/useExhaustiveDependencies: the refused set, as `key`, is what moves
	useEffect(() => {
		const now = new Set(refusedNow);
		const returned = [...refusedBefore.current].some((i) => !now.has(i) && reads[i] && !reads[i].isError);
		refusedBefore.current = now;
		if (!returned) return;
		for (const i of now) void reads[i]?.refetch({ cancelRefetch: false });
	}, [key]);
}
