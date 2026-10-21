import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { refusalStands } from "@/lib/api/read-failed";
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

// ISS-1228 r25 (review F2): a check-in's window that closed while a first read was in flight
// re-asked it once it settled, though it settled refused for good.
describe("a deferred re-read under a predicate", () => {
	const spare = (q: { state: { error: unknown } }) => !refusalStands(q.state.error);

	it.each([
		["passes by a first read that settles refused for good", spare, 1],
		["re-asks it where no predicate spares it", undefined, 2],
	] as const)("%s", async (_name, predicate, expected) => {
		const qc = client();
		let calls = 0;
		const gate = deferred<string>();
		mount(qc, ["holds", "p1"], () => {
			calls += 1;
			return calls === 1 ? gate.promise.then(() => Promise.reject(new ApiError(403, "Not a project member.", "FORBIDDEN"))) : Promise.resolve("v2");
		});
		await tick(5);
		invalidateThroughInFlight(qc, predicate ? { queryKey: ["holds"], predicate } : { queryKey: ["holds"] });
		gate.resolve("go");
		await tick();
		expect(calls).toBe(expected);
	});
});

// ISS-1228 r26: an invalidation cancelled the read in flight and started another, so a stream of frames
// kept one read always restarting and, with the cancelled one still out, two at once.
describe("a read in flight", () => {
	it("is never cut short, and is followed by one re-read however many invalidations arrive meanwhile", async () => {
		const qc = client();
		let calls = 0;
		const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
		const observer = mount(qc, ["holds", "p1"], () => {
			const gate = gates[calls];
			calls += 1;
			return gate?.promise ?? Promise.resolve("late");
		});
		await tick(5);
		gates[0]?.resolve("v1");
		await tick(5);
		expect(calls).toBe(1);

		invalidateThroughInFlight(qc, { queryKey: ["holds"] });
		await tick(5);
		expect(calls).toBe(2);
		for (let n = 0; n < 5; n += 1) invalidateThroughInFlight(qc, { queryKey: ["holds"] });
		await tick(5);
		expect(calls, "an invalidation started a read over the one in flight").toBe(2);

		gates[1]?.resolve("v2");
		await tick();
		expect(observer.getCurrentResult().data).toBe("v2");
		expect(calls, "one re-read follows the read in flight").toBe(3);
		gates[2]?.resolve("v3");
		await tick();
		expect(calls).toBe(3);
	});

	it("hands its re-read to the caller's requeue where one is given, with the widest predicate asked", async () => {
		const qc = client();
		const gate = deferred<string>();
		mount(qc, ["holds", "p1"], () => gate.promise);
		await tick(5);
		const requeue = vi.fn();
		const spare = () => true;
		invalidateThroughInFlight(qc, { queryKey: ["holds"], predicate: spare }, requeue);
		invalidateThroughInFlight(qc, { queryKey: ["holds"] }, requeue);
		gate.resolve("v1");
		await tick();
		expect(requeue).toHaveBeenCalledTimes(1);
		expect(requeue).toHaveBeenCalledWith(["holds", "p1"], undefined);
	});
});

