"use client";

import type { Query, QueryClient, QueryFilters } from "@tanstack/react-query";

type Predicate = NonNullable<QueryFilters["predicate"]>;

/** How a re-read deferred behind a read in flight is asked; the coalescer passes its own, so it keeps the gap. */
export type Requeue = (queryKey: readonly unknown[], predicate: Predicate | undefined) => void;

/** One deferred re-read per query, with the most permissive predicate any invalidation asked it under. */
const deferred = new WeakMap<Query, { predicate: Predicate | undefined }>();

/** Either predicate admitting the query re-reads it; no predicate at all re-reads it whatever its state. */
function widest(a: Predicate | undefined, b: Predicate | undefined): Predicate | undefined {
	if (!a || !b) return undefined;
	return (q) => a(q) || b(q);
}

/**
 * Invalidate what `filters` names without cutting short a read in flight, which react-query's default
 * does (ISS-1228 r26): the read finishes, and one re-read follows however many invalidations arrive.
 */
export function invalidateThroughInFlight(qc: QueryClient, filters: QueryFilters, requeue?: Requeue): void {
	const cache = qc.getQueryCache();
	const inFlight = cache.findAll(filters).filter((q) => q.state.fetchStatus === "fetching");

	qc.invalidateQueries(filters, { cancelRefetch: false });

	const outstanding = new Set<Query>();
	for (const q of inFlight) {
		const already = deferred.get(q);
		if (already) {
			already.predicate = widest(already.predicate, filters.predicate);
			continue;
		}
		deferred.set(q, { predicate: filters.predicate });
		outstanding.add(q);
	}
	if (outstanding.size === 0) return;

	let off: (() => void) | undefined;
	const settle = () => {
		for (const q of [...outstanding]) {
			if (!cache.get(q.queryHash)) {
				outstanding.delete(q);
				deferred.delete(q);
				continue;
			}
			if (q.state.fetchStatus !== "idle") continue;
			outstanding.delete(q);
			const predicate = deferred.get(q)?.predicate;
			deferred.delete(q);
			// The predicate is asked again of the settled query: it may have just been refused.
			if (requeue) requeue(q.queryKey, predicate);
			else qc.invalidateQueries({ queryKey: q.queryKey, exact: true, predicate }, { cancelRefetch: false });
		}
		if (outstanding.size === 0) off?.();
	};

	off = cache.subscribe(settle);
	settle();
}
