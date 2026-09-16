"use client";

// web-v2 feature module: releases — React Query hooks.

import { useQuery } from "@tanstack/react-query";
import { releasesApi } from "./api";

/** The key the release-run screen reads and any future invalidation writes. */
export function releaseRunStateKey(projectId: string, runId: string) {
	return ["release-run-state", projectId, runId] as const;
}

/**
 * One release run, whole.
 *
 * The `live` half of this payload is a probe reading taken while the request is
 * being served, so a cached answer is a reading from whenever it was cached.
 * `staleTime` is therefore zero and the query refetches on a window focus: a
 * person coming back to a tab they left open during an outage is the exact
 * reader this surface exists for, and showing them the pre-outage reading would
 * be the state lying quietly.
 */
export function useReleaseRunState(
	projectId: string | undefined,
	runId: string | undefined,
) {
	return useQuery({
		queryKey: releaseRunStateKey(projectId ?? "", runId ?? ""),
		queryFn: () => releasesApi.getRunState(projectId as string, runId as string),
		enabled: Boolean(projectId && runId),
		staleTime: 0,
		refetchOnWindowFocus: true,
	});
}
