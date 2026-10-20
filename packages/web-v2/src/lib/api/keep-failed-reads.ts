import type { Query, QueryCache } from "@tanstack/react-query";

/**
 * A read that has failed stays failed, with its error, until a refetch answers (ISS-1228 round 22).
 *
 * react-query puts a query that has never answered back to `pending`, with no error, the moment it
 * refetches — on every poll and every socket invalidation — so a screen that reads `isError` says
 * the read failed, then says nothing between retries, and reads the pending gap as "nothing there":
 * the issue page opened another session in place of the one it could not read. A query that holds
 * an earlier answer keeps `error` through a refetch already; this gives one that holds none the same
 * standing. Installed once where the client is built, so every screen reads it.
 */
export function keepFailedReadsFailed(cache: QueryCache): () => void {
	const lastError = new WeakMap<Query, unknown>();
	return cache.subscribe((event) => {
		if (event.type !== "updated") return;
		const { query } = event;
		const action = event.action as { type: string; error?: unknown };
		if (action.type === "error") {
			lastError.set(query, action.error);
			return;
		}
		if (action.type === "success") {
			lastError.delete(query);
			return;
		}
		if (action.type !== "fetch") return;
		const { state } = query;
		if (state.status !== "pending" || state.data !== undefined || state.errorUpdateCount === 0) return;
		if (!lastError.has(query)) return;
		query.setState({ status: "error", error: lastError.get(query) as never });
	});
}
