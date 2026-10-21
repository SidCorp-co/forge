import type { Query, QueryCache } from "@tanstack/react-query";

/** What a read last failed with, and the reading it was showing, read when, as it failed. */
interface Failed {
	error: unknown;
	data: unknown;
	dataUpdatedAt: number;
}

/** A read that failed stays failed until a refetch answers (ISS-1228). Three things are not an
 *  answer and are put back: the refetch react-query starts, which resets a query holding no data to
 *  `pending`; a cache write (`setQueryData`, as a socket frame makes), which it records as a success;
 *  and a refetch that cuts short a failing one, which drops the failure before it was ever recorded. */
export function keepFailedReadsFailed(cache: QueryCache): () => void {
	const lastFailure = new WeakMap<Query, Failed>();
	const failingAttempt = new WeakMap<Query, unknown>();
	const fail = (query: Query, error: unknown) => {
		const { data, dataUpdatedAt } = query.state;
		lastFailure.set(query, { error, data, dataUpdatedAt });
	};
	return cache.subscribe((event) => {
		if (event.type !== "updated") return;
		const { query } = event;
		const action = event.action as { type: string; error?: unknown; manual?: boolean };
		const failed = lastFailure.get(query);
		if (action.type === "failed") {
			failingAttempt.set(query, action.error);
			return;
		}
		if (action.type === "error") {
			failingAttempt.delete(query);
			fail(query, action.error);
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
			if (action.manual) return;
			failingAttempt.delete(query);
			lastFailure.delete(query);
			return;
		}
		if (action.type !== "fetch") return;
		if (failingAttempt.has(query)) {
			const error = failingAttempt.get(query);
			failingAttempt.delete(query);
			fail(query, error);
			query.setState({ status: "error", error: error as never });
			return;
		}
		const { state } = query;
		if (!failed || state.status !== "pending" || state.data !== undefined || state.errorUpdateCount === 0) return;
		query.setState({ status: "error", error: failed.error as never });
	});
}
