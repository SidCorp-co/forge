"use client";

import type { Query, QueryClient, QueryFilters } from "@tanstack/react-query";

export function invalidateThroughInFlight(qc: QueryClient, filters: QueryFilters): void {
	const cache = qc.getQueryCache();
	const midFirstFetch = cache
		.findAll(filters)
		.filter((q) => q.state.fetchStatus === "fetching" && q.state.dataUpdatedAt === 0);

	qc.invalidateQueries(filters);
	if (midFirstFetch.length === 0) return;

	const outstanding = new Set<Query>(midFirstFetch);
	let off: (() => void) | undefined;
	const settle = () => {
		for (const q of [...outstanding]) {
			const stillCached = cache.get(q.queryHash);
			if (!stillCached) {
				outstanding.delete(q);
				continue;
			}
			if (q.state.fetchStatus !== "idle") continue;
			outstanding.delete(q);
			qc.invalidateQueries({ queryKey: q.queryKey, exact: true });
		}
		if (outstanding.size === 0) off?.();
	};

	off = cache.subscribe(settle);
	settle();
}
