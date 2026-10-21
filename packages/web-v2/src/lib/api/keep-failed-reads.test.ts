import { QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { createQueryClient } from "@/providers/query-provider";
import { ApiError } from "./client";

/** A read whose answers come from a list, one per fetch; a pending entry never settles until released. */
function scripted(outcomes: Array<"fail" | "ok" | "hang">) {
	let n = 0;
	const hung: Array<() => void> = [];
	return {
		hung,
		fn: () => {
			const next = outcomes[n++] ?? "ok";
			if (next === "fail") return Promise.reject(new ApiError(503, "Forge is restarting.", "UNAVAILABLE"));
			if (next === "hang") return new Promise<string>((resolve) => hung.push(() => resolve("answered")));
			return Promise.resolve("answered");
		},
	};
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("a read that has failed stays failed until a refetch answers (criterion 224)", () => {
	it("keeps isError and its error through every refetch that has not answered", async () => {
		const client = createQueryClient();
		const read = scripted(["fail", "hang", "fail", "hang"]);
		const observer = new QueryObserver(client, { queryKey: ["holds"], queryFn: read.fn, retry: false });
		const unsubscribe = observer.subscribe(() => {});
		await settle();
		const failed = observer.getCurrentResult();
		expect(failed.isError).toBe(true);
		const error = failed.error;

		// A poll refetches while the failure still stands: the read is failed, not "nothing yet".
		void observer.refetch();
		await settle();
		expect(observer.getCurrentResult()).toMatchObject({ isError: true, isPending: false, isFetching: true, error });
		read.hung[0]?.();
		await settle();
		expect(observer.getCurrentResult()).toMatchObject({ isSuccess: true, data: "answered", error: null });
		unsubscribe();
	});

	it("says the newest failure, and lets a reset read start over", async () => {
		const client = createQueryClient();
		const read = scripted(["fail", "fail", "hang"]);
		const observer = new QueryObserver(client, { queryKey: ["runs"], queryFn: read.fn, retry: false });
		const unsubscribe = observer.subscribe(() => {});
		await settle();
		const first = observer.getCurrentResult().error;
		await observer.refetch();
		const second = observer.getCurrentResult().error;
		expect(second).not.toBe(first);
		expect(observer.getCurrentResult().isError).toBe(true);

		void client.resetQueries({ queryKey: ["runs"] });
		await settle();
		expect(observer.getCurrentResult()).toMatchObject({ isPending: true, isError: false });
		unsubscribe();
	});
});

// Round 23 (judge-74): a read that had answered and then failed lost its failure on the next socket
// frame, because a frame writes the cache and react-query records any write as a success.
describe("a read that answered and then failed stays failed until a refetch answers (criterion 233)", () => {
	async function answeredThenFailed() {
		const client = createQueryClient();
		const read = scripted(["ok", "fail", "hang"]);
		const observer = new QueryObserver(client, { queryKey: ["sessions-and-holds", "p"], queryFn: read.fn, retry: false });
		const unsubscribe = observer.subscribe(() => {});
		await settle();
		const shown = observer.getCurrentResult();
		expect(shown.data).toBe("answered");
		await observer.refetch();
		const failed = observer.getCurrentResult();
		expect(failed).toMatchObject({ isError: true, data: "answered" });
		return { client, read, observer, unsubscribe, readAt: shown.dataUpdatedAt, error: failed.error };
	}

	it("keeps the failure, the reading and when it was read through a cache write", async () => {
		const { client, observer, unsubscribe, readAt, error } = await answeredThenFailed();
		client.setQueryData(["sessions-and-holds", "p"], "written by a frame");
		await settle();
		expect(observer.getCurrentResult()).toMatchObject({ isError: true, error, data: "answered", dataUpdatedAt: readAt });
		unsubscribe();
	});

	it("keeps the failure through a write that changes nothing", async () => {
		const { client, observer, unsubscribe, error } = await answeredThenFailed();
		client.setQueriesData({ queryKey: ["sessions-and-holds"] }, (prev) => prev);
		await settle();
		expect(observer.getCurrentResult()).toMatchObject({ isError: true, error, data: "answered" });
		unsubscribe();
	});

	it("keeps the failure while a refetch is out, and clears it only when one answers", async () => {
		const { client, read, observer, unsubscribe, error } = await answeredThenFailed();
		void observer.refetch();
		await settle();
		client.setQueryData(["sessions-and-holds", "p"], "written by a frame");
		await settle();
		expect(observer.getCurrentResult()).toMatchObject({ isError: true, error, isFetching: true, data: "answered" });
		read.hung[0]?.();
		await settle();
		expect(observer.getCurrentResult()).toMatchObject({ isSuccess: true, error: null, data: "answered" });
		client.setQueryData(["sessions-and-holds", "p"], "written by a frame");
		expect(observer.getCurrentResult()).toMatchObject({ isSuccess: true, data: "written by a frame" });
		unsubscribe();
	});

	it("keeps a never-answered read failed through a cache write", async () => {
		const client = createQueryClient();
		const read = scripted(["fail"]);
		const observer = new QueryObserver(client, { queryKey: ["holds", "never"], queryFn: read.fn, retry: false });
		const unsubscribe = observer.subscribe(() => {});
		await settle();
		const error = observer.getCurrentResult().error;
		client.setQueryData(["holds", "never"], "written by a frame");
		await settle();
		expect(observer.getCurrentResult()).toMatchObject({ isError: true, error, data: undefined });
		unsubscribe();
	});
});

// Round 23, on the rig: with a frame each second every failing refetch was cut short by the next one,
// silently, before its retries ran out, so the read never once said it had failed.
describe("a failing refetch cut short by another still says the read failed (criterion 233)", () => {
	it("records the failed attempt as the read's failure when a refetch replaces it", async () => {
		const client = createQueryClient();
		let calls = 0;
		const lost = new ApiError(503, "Forge is restarting.", "UNAVAILABLE");
		const observer = new QueryObserver(client, {
			queryKey: ["sessions-and-holds", "cut"],
			queryFn: () => (calls++ === 0 ? Promise.resolve("answered") : Promise.reject(lost)),
			retry: 2,
			retryDelay: 60_000,
		});
		const unsubscribe = observer.subscribe(() => {});
		await settle();
		expect(observer.getCurrentResult()).toMatchObject({ isSuccess: true, data: "answered" });

		// A refetch whose first attempt fails and waits a minute to retry.
		void observer.refetch();
		await settle();
		expect(observer.getCurrentResult()).toMatchObject({ isSuccess: true, failureCount: 1 });

		// A frame's invalidation starts another before that retry: the failure is said, not dropped.
		void client.invalidateQueries({ queryKey: ["sessions-and-holds"] });
		await settle();
		expect(observer.getCurrentResult()).toMatchObject({ isError: true, error: lost, data: "answered" });
		void client.invalidateQueries({ queryKey: ["sessions-and-holds"] });
		await settle();
		expect(observer.getCurrentResult()).toMatchObject({ isError: true, error: lost, data: "answered" });
		unsubscribe();
		client.clear();
	});
});
