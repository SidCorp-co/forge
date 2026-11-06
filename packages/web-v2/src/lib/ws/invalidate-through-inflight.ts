import type { Query, QueryClient, QueryFilters } from "@tanstack/react-query";

/** The reads that owe one more fetch once the flight they are in settles, per client. */
const owing = new WeakMap<QueryClient, Set<Query>>();

/**
 * Invalidate what `filters` matches without cancelling a read already in flight. A frame says the
 * answer may have moved: a read sent before the frame owes one more fetch, sent once it settles. Many
 * frames during one flight owe that one fetch, never one each.
 *
 * Cancelling the flight and sending again on every frame was the default (`cancelRefetch`), and on a
 * busy project a read slower than the gap between frames never answered: the shell's attention and
 * Needs you reads (4–6 s on forge-dev) went again on each frame, the request still running in core,
 * and an issue page sent 138 calls (ISS-1070).
 */
export function invalidateThroughInFlight(qc: QueryClient, filters: QueryFilters): void {
	const cache = qc.getQueryCache();
	const inFlight = cache.findAll(filters).filter((q) => q.state.fetchStatus === "fetching");

	void qc.invalidateQueries(filters, { cancelRefetch: false });
	if (inFlight.length === 0) return;

	let owed = owing.get(qc);
	if (!owed) {
		owed = new Set();
		owing.set(qc, owed);
	}
	const fresh = inFlight.filter((q) => !owed.has(q));
	for (const q of fresh) owed.add(q);
	if (fresh.length === 0) return;

	const outstanding = new Set<Query>(fresh);
	const settle = () => {
		for (const q of [...outstanding]) {
			if (!cache.get(q.queryHash)) {
				outstanding.delete(q);
				owed.delete(q);
				continue;
			}
			if (q.state.fetchStatus !== "idle") continue;
			outstanding.delete(q);
			owed.delete(q);
			void qc.invalidateQueries({ queryKey: q.queryKey, exact: true }, { cancelRefetch: false });
		}
		if (outstanding.size === 0) off();
	};

	const off = cache.subscribe(settle);
	settle();
}
