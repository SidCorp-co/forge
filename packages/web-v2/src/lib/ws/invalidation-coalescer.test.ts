import type { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	INVALIDATE_WINDOW_MS,
	flushInvalidations,
	scheduleInvalidation,
} from "./invalidation-coalescer";

function capture() {
	const keys: string[] = [];
	const qc = {
		invalidateQueries: ({ queryKey }: { queryKey?: unknown[] }) => {
			keys.push(JSON.stringify(queryKey));
		},
		getQueryCache: () => ({
			findAll: () => [],
			subscribe: () => () => {},
			get: () => undefined,
		}),
	} as unknown as QueryClient;
	return { qc, keys };
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	flushInvalidations();
	vi.useRealTimers();
});

describe("scheduleInvalidation", () => {
	// cm:guard twenty events is the burst the issue names, and the figure that matters is ONE — before this, twenty `issue.statusChanged` frames refired the hydrated issues search twenty times (ISS-1019).
	it("collapses twenty schedules of one key inside a window into one invalidation", () => {
		const c = capture();
		for (let i = 0; i < 20; i += 1) scheduleInvalidation(c.qc, ["issues", "search"]);
		expect(c.keys).toEqual([]);

		vi.advanceTimersByTime(INVALIDATE_WINDOW_MS);
		expect(c.keys).toEqual([JSON.stringify(["issues", "search"])]);
	});

	it("keeps distinct keys distinct rather than collapsing them together", () => {
		const c = capture();
		scheduleInvalidation(c.qc, ["issues", "search"]);
		scheduleInvalidation(c.qc, ["pulse"]);
		scheduleInvalidation(c.qc, ["issues", "search"]);

		vi.advanceTimersByTime(INVALIDATE_WINDOW_MS);
		expect(c.keys.sort()).toEqual(
			[JSON.stringify(["issues", "search"]), JSON.stringify(["pulse"])].sort(),
		);
	});

	// cm:guard the deadline is FIXED, not trailing: an event arriving mid-window must not push it back, or a project under sustained traffic never refetches at all — exactly when there is most to see.
	it("does not push the deadline back when events keep arriving inside the window", () => {
		const c = capture();
		scheduleInvalidation(c.qc, ["pulse"]);
		vi.advanceTimersByTime(INVALIDATE_WINDOW_MS - 10);
		scheduleInvalidation(c.qc, ["pulse"]);
		scheduleInvalidation(c.qc, ["pulse"]);
		expect(c.keys).toEqual([]);

		vi.advanceTimersByTime(10);
		expect(c.keys).toEqual([JSON.stringify(["pulse"])]);
	});

	// cm:guard the pair to the case above: a fixed window promises ONE invalidation per window, never one per burst of arbitrary length, and this is what says so.
	it("opens a second window for an event arriving after the first has closed", () => {
		const c = capture();
		scheduleInvalidation(c.qc, ["pulse"]);
		vi.advanceTimersByTime(INVALIDATE_WINDOW_MS);
		expect(c.keys).toHaveLength(1);

		scheduleInvalidation(c.qc, ["pulse"]);
		vi.advanceTimersByTime(INVALIDATE_WINDOW_MS);
		expect(c.keys).toHaveLength(2);
	});

	// cm:guard one window, EVERY client that asked for it: overwriting a single slot with the last schedule leaves the first consumer's screen stale, and `use-websocket.ts` states that multiple mounted calls are safe.
	it("fires one window into every client that scheduled it", () => {
		const a = capture();
		const b = capture();
		scheduleInvalidation(a.qc, ["pulse"]);
		scheduleInvalidation(b.qc, ["pulse"]);

		vi.advanceTimersByTime(INVALIDATE_WINDOW_MS);

		expect(a.keys).toEqual([JSON.stringify(["pulse"])]);
		expect(b.keys).toEqual([JSON.stringify(["pulse"])]);
	});

	it("closes every open window when flushed", () => {
		const c = capture();
		scheduleInvalidation(c.qc, ["a"]);
		scheduleInvalidation(c.qc, ["b"]);
		flushInvalidations();
		expect(c.keys.sort()).toEqual([JSON.stringify(["a"]), JSON.stringify(["b"])].sort());

		vi.advanceTimersByTime(INVALIDATE_WINDOW_MS * 4);
		expect(c.keys).toHaveLength(2);
	});
});
