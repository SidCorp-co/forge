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

	it("opens a second window for an event arriving after the first has closed", () => {
		const c = capture();
		scheduleInvalidation(c.qc, ["pulse"]);
		vi.advanceTimersByTime(INVALIDATE_WINDOW_MS);
		expect(c.keys).toHaveLength(1);

		scheduleInvalidation(c.qc, ["pulse"]);
		vi.advanceTimersByTime(INVALIDATE_WINDOW_MS);
		expect(c.keys).toHaveLength(2);
	});

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
