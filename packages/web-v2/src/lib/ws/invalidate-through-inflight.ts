"use client";

import type { Query, QueryClient, QueryFilters } from "@tanstack/react-query";

/**
 * Invalidate, and then invalidate again the queries whose FIRST fetch was still
 * running when it happened.
 *
 * Measured against @tanstack/react-query 5.101.4: `Query.fetch` returns the
 * existing retryer promise when a fetch is already running and the query holds
 * no data, so an invalidation aimed at such a query starts no second call AND
 * leaves `isInvalidated` false once the first one settles. The live update it
 * carried is lost, with nothing red anywhere to say so. A query that holds data
 * and is refetching does not have this problem — that invalidation is honoured.
 *
 * The follow-up is deliberately conservative: where the event landed before the
 * server took that first request's snapshot, the answer already carries the
 * change and the second request is redundant. Nothing on the wire distinguishes
 * the two — no response carries a snapshot time or a version — so the choice is
 * between a redundant request and a live update that silently never arrives,
 * and this takes the redundant request. It ends if a response ever carries a
 * marker this can compare against.
 */
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
