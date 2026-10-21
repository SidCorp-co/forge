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
	// A read refused 403 stays remembered through any other failure, until it answers.
	const refusedOnce = useRef(new Set<number>());
	const states = reads.map((read) => (refusedAccess(read) ? "r" : read.isError ? "e" : "a")).join("");

	// biome-ignore lint/correctness/useExhaustiveDependencies: each read's state, as `states`, is what moves
	useEffect(() => {
		let returned = false;
		reads.forEach((read, i) => {
			if (refusedAccess(read)) refusedOnce.current.add(i);
			else if (!read.isError && refusedOnce.current.delete(i)) returned = true;
		});
		if (!returned) return;
		for (const read of reads) if (refusedAccess(read)) void read.refetch({ cancelRefetch: false });
	}, [states]);
}
