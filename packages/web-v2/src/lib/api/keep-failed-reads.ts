import type { Query, QueryCache } from "@tanstack/react-query";

/** A read that failed stays failed until a refetch answers: react-query resets a query holding no
 *  data to `pending` on every refetch, which a screen reads as "nothing there" (ISS-1228). */
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
