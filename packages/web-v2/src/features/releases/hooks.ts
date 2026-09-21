"use client";

// web-v2 feature module: releases — React Query hooks.

import { useQuery } from "@tanstack/react-query";
import { releasesApi } from "./api";

/** The key the release-run screen reads and any future invalidation writes. */
export function releaseRunStateKey(projectId: string, runId: string) {
	return ["release-run-state", projectId, runId] as const;
}

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
