import { describe, expect, it } from "vitest";
import {
	loopCloseFromConfirm,
	RECORDER_EVENTS,
	RECORDER_OPTIONS,
	RECORDER_PATHS,
	RECORDING_LIMITS,
	RECORDING_MACHINE,
	type RrwebEvent,
	recordingBatchSchema,
	timelineOf,
} from "./reproduce.js";

const t0 = 1_760_000_000_000;
const ev = (type: number, at: number, data: unknown): RrwebEvent => ({
	type,
	timestamp: t0 + at,
	data,
});

// FB-52 from the mockup: the release page's version cell renders empty at 390px wide
const fb52: RrwebEvent[] = [
	ev(4, 0, {
		href: "https://p-abcdefghijklmnop.iosbenchmarks.com/releases/0.4.0-dev.217",
		width: 390,
		height: 844,
	}),
	ev(2, 1, { node: {} }),
	ev(3, 2500, { source: 5, id: 12, text: "*****" }),
	ev(5, 4000, { tag: RECORDER_EVENTS.click, payload: { label: "Version" } }),
	ev(3, 4001, { source: 2, type: 2, id: 40, x: 10, y: 20 }),
	ev(6, 5000, {
		plugin: "rrweb/console@1",
		payload: {
			level: "error",
			payload: ['"TypeError: version.split is not a function"'],
			trace: ["release-header.tsx:41"],
		},
	}),
	ev(6, 5200, {
		plugin: "rrweb/network@1",
		payload: {
			requests: [
				{ name: "/api/releases/0.4.0-dev.217", method: "GET", status: 200 },
				{
					name: "/api/releases/0.4.0-dev.217/notes",
					method: "GET",
					status: 500,
				},
				{ name: "/api/metrics", method: "POST", status: 0 },
			],
		},
	}),
	ev(3, 9000, { source: 4, width: 844, height: 390 }),
	ev(6, 9100, {
		plugin: "rrweb/console@1",
		payload: { level: "log", payload: ["fine"] },
	}),
];

describe("a recording read as what was done and what the page logged (BC-18, BC-19)", () => {
	it("reads FB-52's session in order", () => {
		expect(timelineOf(fb52)).toEqual([
			{
				at: 0,
				kind: "navigate",
				text: "Opened https://p-abcdefghijklmnop.iosbenchmarks.com/releases/0.4.0-dev.217",
			},
			{ at: 0, kind: "viewport", text: "Window 390×844" },
			{ at: 2500, kind: "input", text: "Typed in a field (masked)" },
			{ at: 4000, kind: "click", text: "Clicked Version" },
			{
				at: 5000,
				kind: "console_error",
				text: 'console.error: "TypeError: version.split is not a function"',
			},
			{
				at: 5200,
				kind: "request_failed",
				text: "GET /api/releases/0.4.0-dev.217/notes answered 500",
			},
			{
				at: 5200,
				kind: "request_failed",
				text: "POST /api/metrics failed with no answer",
			},
			{ at: 9000, kind: "viewport", text: "Window resized to 844×390" },
		]);
	});

	it("never carries what was typed, whatever the event holds", () => {
		const leaked = timelineOf([
			ev(3, 0, { source: 5, id: 1, text: "hunter2" }),
		]);
		expect(JSON.stringify(leaked)).not.toContain("hunter2");
	});

	it("keeps at most the timeline cap and clips a long line", () => {
		const many = Array.from(
			{ length: RECORDING_LIMITS.timelineEntries + 10 },
			(_, i) => ev(3, i, { source: 5 }),
		);
		expect(timelineOf(many)).toHaveLength(RECORDING_LIMITS.timelineEntries);
		const long = timelineOf([
			ev(6, 0, {
				plugin: "rrweb/console@1",
				payload: { level: "error", payload: ["x".repeat(2000)] },
			}),
		]);
		expect(long[0]?.text.length).toBe(RECORDING_LIMITS.entryText);
	});

	it("reads nothing from nothing", () => {
		expect(timelineOf([])).toEqual([]);
	});
});

describe("the recorder and its batches", () => {
	it("masks every input and records no header or body", () => {
		expect(RECORDER_OPTIONS.record.maskAllInputs).toBe(true);
		expect(RECORDER_OPTIONS.network.recordHeaders).toBe(false);
		expect(RECORDER_OPTIONS.network.recordBody).toBe(false);
	});

	it("lives under the reserved prefix the dev server never sees", () => {
		for (const p of Object.values(RECORDER_PATHS))
			expect(p.startsWith("/__forge_preview/")).toBe(true);
	});

	it("takes a batch in order and refuses an empty or oversize one", () => {
		const batch = {
			recordingId: "8df98619-9f7c-46b8-8e65-a67f2fcdce74",
			seq: 0,
			events: fb52,
		};
		expect(recordingBatchSchema.safeParse(batch).success).toBe(true);
		expect(
			recordingBatchSchema.safeParse({ ...batch, events: [] }).success,
		).toBe(false);
		expect(recordingBatchSchema.safeParse({ ...batch, seq: -1 }).success).toBe(
			false,
		);
		expect(
			recordingBatchSchema.safeParse({
				...batch,
				events: [{ type: 9, timestamp: 1, data: {} }],
			}).success,
		).toBe(false);
	});

	it("lets only the kernel fail or expire a recording, and a redactor delete it", () => {
		const by = (act: string) =>
			RECORDING_MACHINE.edges
				.filter((e) => e.act === act)
				.map((e) => e.permission);
		expect(by("recording.failed")).toEqual([null]);
		expect(by("recording.expired")).toEqual([null]);
		expect(new Set(by("recording.redacted"))).toEqual(
			new Set(["feedback.redact"]),
		);
	});
});

describe("the reporter's confirm answers the loop close ahead (BC-20)", () => {
	const A = "a".repeat(40);
	const B = "b".repeat(40);

	it("is gone when they said fixed and what shipped is what they saw", () => {
		expect(
			loopCloseFromConfirm(
				[{ patchId: A, verdict: "fixed", at: "2026-10-09T10:00:00Z" }],
				A,
			),
		).toBe("gone");
	});

	it("asks again when what shipped is not what they saw, or nothing has shipped", () => {
		expect(
			loopCloseFromConfirm(
				[{ patchId: A, verdict: "fixed", at: "2026-10-09T10:00:00Z" }],
				B,
			),
		).toBeNull();
		expect(
			loopCloseFromConfirm(
				[{ patchId: A, verdict: "fixed", at: "2026-10-09T10:00:00Z" }],
				null,
			),
		).toBeNull();
		expect(loopCloseFromConfirm([], A)).toBeNull();
	});

	it("reads the latest confirm: not fixed after fixed is not gone", () => {
		const confirms = [
			{ patchId: A, verdict: "fixed" as const, at: "2026-10-09T10:00:00Z" },
			{ patchId: A, verdict: "not_fixed" as const, at: "2026-10-09T11:00:00Z" },
		];
		expect(loopCloseFromConfirm(confirms, A)).toBe("not_gone");
	});
});
