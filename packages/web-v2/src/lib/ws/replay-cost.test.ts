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

const REMOVED_BLANKET_REPLAY = [
	["issues"],
	["jobs"],
	["projects"],
	["agent-sessions"],
	["agent-session"],
	["conversations"],
	["attention"],
	["pulse"],
	["devices", "me"],
	["chat-logs"],
	["integrations"],
	["integration-connections"],
	["questions"],
];

function blanketReplay(qc: QueryClient): void {
	for (const queryKey of REMOVED_BLANKET_REPLAY) qc.invalidateQueries({ queryKey });
}

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
	it("costs a query still in flight with no data ONE call, under either replay", async () => {
		for (const replay of [blanketReplay, (qc: QueryClient) => replayOnFirstOpen(qc, Date.now())]) {
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

	it("costs a query settled before the open TWO calls, under either replay", async () => {
		for (const replay of [blanketReplay, (qc: QueryClient) => replayOnFirstOpen(qc, Date.now())]) {
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

	it("costs a mixed cold load the same total under both replays", async () => {
		const totals: number[] = [];
		for (const replay of [blanketReplay, (qc: QueryClient) => replayOnFirstOpen(qc, Date.now())]) {
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

	it("repairs the open count after a reconnect, which focus used to do", async () => {
		const qc = client();
		let calls = 0;
		mount(qc, ["notifications-open"], async () => {
			calls += 1;
			return { count: calls };
		});
		await tick();
		expect(calls).toBe(1);

		replayOnReconnect(qc);
		await tick();

		expect(calls).toBe(2);
	});

	it("leaves the closed bell's list stale, so opening it fetches rather than serving the gap", async () => {
		const qc = client();
		qc.setQueryData(["notifications"], { items: [], totalCount: 0 });
		expect(qc.getQueryState(["notifications"])?.isInvalidated).toBe(false);

		replayOnReconnect(qc);
		await tick();

		expect(qc.getQueryState(["notifications"])?.isInvalidated).toBe(true);
	});

	it("repairs a query whose first fetch was running across a reconnect", async () => {
		const qc = client();
		let calls = 0;
		const gate = deferred<string>();
		mount(qc, ["issues", "list"], () => {
			calls += 1;
			return gate.promise;
		});
		await tick(5);
		expect(calls).toBe(1);

		replayOnReconnect(qc);
		gate.resolve("v1");
		await tick();

		expect(calls).toBe(2);
	});

	it("raises a first-fetch questions query from one call to two", async () => {
		const counts: number[] = [];
		for (const replay of [blanketReplay, (qc: QueryClient) => replayOnFirstOpen(qc, Date.now())]) {
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
