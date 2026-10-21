import type { Query, QueryCache } from "@tanstack/react-query";

/** What a read last failed with, and the reading it was showing, read when, as it failed. */
interface Failed {
	error: unknown;
	data: unknown;
	dataUpdatedAt: number;
}

/** A read that failed stays failed until a refetch answers (ISS-1228). Two things are not an answer:
 *  the refetch react-query starts, which resets a query holding no data to `pending`, and a cache
 *  write (`setQueryData`, as a socket frame makes), which it records as a success. Each is put back. */
export function keepFailedReadsFailed(cache: QueryCache): () => void {
	const lastFailure = new WeakMap<Query, Failed>();
	return cache.subscribe((event) => {
		if (event.type !== "updated") return;
		const { query } = event;
		const action = event.action as { type: string; error?: unknown; manual?: boolean };
		const failed = lastFailure.get(query);
		if (action.type === "error") {
			const { data, dataUpdatedAt } = query.state;
			lastFailure.set(query, { error: action.error, data, dataUpdatedAt });
			return;
		}
		if (action.type === "success") {
			if (action.manual && failed) {
				query.setState({
					status: "error",
					error: failed.error as never,
					data: failed.data as never,
					dataUpdatedAt: failed.dataUpdatedAt,
				});
				return;
			}
			lastFailure.delete(query);
			return;
		}
		if (action.type !== "fetch" || !failed) return;
		const { state } = query;
		if (state.status !== "pending" || state.data !== undefined || state.errorUpdateCount === 0) return;
		query.setState({ status: "error", error: failed.error as never });
	});
}
