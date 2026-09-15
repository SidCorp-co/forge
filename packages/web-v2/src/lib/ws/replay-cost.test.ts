import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { replayOnFirstOpen, replayOnReconnect, routeEvent } from "./event-router";
import { flushInvalidations } from "./invalidation-coalescer";

/**
 * What a replay and a burst actually COST, counted in query-function calls
 * against a real QueryClient at @tanstack/react-query 5.101.4 rather than in
 * `invalidateQueries` calls against a stub.
 *
 * The three states a query can be in when a replay runs do not cost the same
 * thing, and the filing for ISS-1019 described one of them as if it were all
 * three. These cases are the measurement that says otherwise, kept so the
 * figures this change does NOT move are on the record beside the one it does.
 */

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

const tick = (ms = 40) => new Promise<void>((r) => setTimeout(r, ms));
const unsubs: Array<() => void> = [];

function client() {
	return new QueryClient({
		defaultOptions: { queries: { staleTime: 60_000, gcTime: 300_000, retry: false } },
	});
}

function mount(qc: QueryClient, queryKey: unknown[], queryFn: () => Promise<unknown>) {
	const observer = new QueryObserver(qc, { queryKey, queryFn });
	unsubs.push(observer.subscribe(() => {}));
}

afterEach(() => {
	flushInvalidations();
	while (unsubs.length > 0) unsubs.pop()?.();
});

describe("what a first-open replay costs, by the state of the query it lands on", () => {
	// cm:guard ONE call, not two: `Query.fetch` returns the existing retryer when a fetch is running and the query holds no data, so the blanket replay never doubled a cold load's in-flight queries and removing it saves nothing there (ISS-1019).
	it("costs a query still in flight with no data ONE call, under either replay", async () => {
		for (const replay of [replayOnReconnect, (qc: QueryClient) => replayOnFirstOpen(qc, Date.now())]) {
			const qc = client();
			let calls = 0;
			const gate = deferred<string>();
			mount(qc, ["issues", "list"], () => {
				calls += 1;
				return gate.promise;
			});
			await tick(5);

			replay(qc);
			gate.resolve("v1");
			await tick();

			expect(calls).toBe(1);
		}
	});

	// cm:guard TWO calls under the blanket replay and two under the new one: a query already settled when the socket opened had its answer on screen while the socket was not delivering, which is a real gap, so this is the one case the first-open replay must keep paying for.
	it("costs a query settled before the open TWO calls, under either replay", async () => {
		for (const replay of [replayOnReconnect, (qc: QueryClient) => replayOnFirstOpen(qc, Date.now())]) {
			const qc = client();
			let calls = 0;
			mount(qc, ["issues", "list"], async () => {
				calls += 1;
				return `v${calls}`;
			});
			await tick();
			expect(calls).toBe(1);

			replay(qc);
			await tick();

			expect(calls).toBe(2);
		}
	});

	// cm:guard the mixed cold load the issue asks for, both ways, and the point is that the totals are EQUAL: the first-open half of ISS-1019 moves no request count, and what it buys is a rule that is explicit and tested rather than accidental.
	it("costs a mixed cold load the same total under both replays", async () => {
		const totals: number[] = [];
		for (const replay of [replayOnReconnect, (qc: QueryClient) => replayOnFirstOpen(qc, Date.now())]) {
			const qc = client();
			let calls = 0;
			const gate = deferred<string>();
			mount(qc, ["issues", "list"], async () => {
				calls += 1;
				return `settled${calls}`;
			});
			mount(qc, ["jobs", "list"], () => {
				calls += 1;
				return gate.promise;
			});
			await tick();

			replay(qc);
			gate.resolve("inflight");
			await tick();
			totals.push(calls);
		}

		expect(totals[0]).toBe(3);
		expect(totals[1]).toBe(totals[0]);
	});

	// cm:guard the ONE figure this change moves, and it moves UP: a questions query on its first fetch had its unconditional replay swallowed by the blanket path, and `invalidateThroughInFlight` is that prefix's recovery finally happening rather than appearing to.
	it("raises a first-fetch questions query from one call to two", async () => {
		const counts: number[] = [];
		for (const replay of [replayOnReconnect, (qc: QueryClient) => replayOnFirstOpen(qc, Date.now())]) {
			const qc = client();
			let calls = 0;
			const gate = deferred<string>();
			mount(qc, ["questions", "i1"], () => {
				calls += 1;
				return gate.promise;
			});
			await tick(5);

			replay(qc);
			gate.resolve("q1");
			await tick();
			counts.push(calls);
		}

		expect(counts[0]).toBe(1);
		expect(counts[1]).toBe(2);
	});
});

describe("what a burst of events costs", () => {
	// cm:guard twenty transitions used to refire the hydrated issues search twenty times. One is the figure; counting `invalidateQueries` calls instead of query-function calls would pass against a coalescer that collapsed nothing the query client acted on.
	it("costs each affected query ONE call beyond its first fetch, for twenty events", async () => {
		const qc = client();
		const calls = new Map<string, number>();
		for (const key of [
			["issues", "list"],
			["issues", "search"],
			["attention"],
			["pulse"],
			["recent-changes"],
		]) {
			const hash = JSON.stringify(key);
			calls.set(hash, 0);
			mount(qc, key, async () => {
				calls.set(hash, (calls.get(hash) ?? 0) + 1);
				return hash;
			});
		}
		await tick();
		expect([...calls.values()]).toEqual([1, 1, 1, 1, 1]);

		for (let i = 0; i < 20; i += 1) {
			routeEvent(
				{ event: "issue.statusChanged", data: { issueId: `i${i}` }, timestamp: "t" },
				qc,
			);
		}
		flushInvalidations();
		await tick();

		expect([...calls.values()]).toEqual([2, 2, 2, 2, 2]);
	});
});
