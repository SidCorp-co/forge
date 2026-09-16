import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { invalidateThroughInFlight } from "./invalidate-through-inflight";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

const tick = (ms = 40) => new Promise<void>((r) => setTimeout(r, ms));
const unsubs: Array<() => void> = [];

function mount(qc: QueryClient, queryKey: readonly unknown[], queryFn: () => Promise<unknown>) {
	const observer = new QueryObserver(qc, { queryKey: [...queryKey], queryFn });
	unsubs.push(observer.subscribe(() => {}));
	return observer;
}

afterEach(() => {
	while (unsubs.length > 0) unsubs.pop()?.();
});

const client = () =>
	new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: false } } });

describe("invalidateThroughInFlight", () => {
	it("refetches a query whose FIRST fetch was still running, once it settles", async () => {
		const qc = client();
		let calls = 0;
		const gates = [deferred<string>(), deferred<string>()];
		mount(qc, ["issues", "list"], () => {
			const gate = gates[calls];
			calls += 1;
			return gate?.promise ?? Promise.resolve("late");
		});
		await tick(5);
		expect(calls).toBe(1);

		invalidateThroughInFlight(qc, { queryKey: ["issues"] });
		gates[0]?.resolve("v1");
		await tick();

		expect(calls).toBe(2);
	});

	it("does not add a follow-up for a query that already holds data", async () => {
		const qc = client();
		let calls = 0;
		mount(qc, ["issues", "list"], async () => {
			calls += 1;
			return `v${calls}`;
		});
		await tick();
		expect(calls).toBe(1);

		invalidateThroughInFlight(qc, { queryKey: ["issues"] });
		await tick();

		expect(calls).toBe(2);
	});

	it("releases its cache subscription when the query it was waiting on is removed", async () => {
		const qc = client();
		const cache = qc.getQueryCache();
		const gate = deferred<string>();
		mount(qc, ["issues", "list"], () => gate.promise);
		await tick(5);

		let subscribers = 0;
		const countBefore = (cache as unknown as { listeners: Set<unknown> }).listeners.size;
		invalidateThroughInFlight(qc, { queryKey: ["issues"] });
		subscribers = (cache as unknown as { listeners: Set<unknown> }).listeners.size;
		expect(subscribers).toBeGreaterThan(countBefore);

		cache.clear();
		await tick();

		expect((cache as unknown as { listeners: Set<unknown> }).listeners.size).toBe(countBefore);
		gate.resolve("never read");
	});

	it("invalidates nothing outside the filter it was given", async () => {
		const qc = client();
		let issues = 0;
		let jobs = 0;
		mount(qc, ["issues", "list"], async () => {
			issues += 1;
			return "i";
		});
		mount(qc, ["jobs", "list"], async () => {
			jobs += 1;
			return "j";
		});
		await tick();

		invalidateThroughInFlight(qc, { queryKey: ["issues"] });
		await tick();

		expect(issues).toBe(2);
		expect(jobs).toBe(1);
	});
});
