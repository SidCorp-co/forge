import { describe, expect, it } from "vitest";
import {
	CHECK_KINDS,
	checkTimeByKind,
	recordChecksRequestSchema,
} from "./check-runs.js";
import { mergeCheckReportSchema } from "./merge-check.js";

const HEAD = "a".repeat(40);

const check = (over: Record<string, unknown> = {}) => ({
	id: "6f1d3c1e-8a0b-4c55-9d43-2f3a1b0c9e11",
	kind: "tests",
	name: "direct-tests",
	scope: "@forge/core",
	command: "vitest run",
	files: ["packages/core/src/a.test.ts"],
	result: "pass",
	durationMs: 1200,
	startedAt: "2026-10-09T06:00:00.000Z",
	...over,
});

const issuesOf = (body: unknown) => {
	const parsed = recordChecksRequestSchema.safeParse(body);
	return parsed.success
		? []
		: parsed.error.issues.map((i) => `${i.path.join("/")}: ${i.message}`);
};

describe("a check sent to be recorded", () => {
	it("takes a timed check with its kind", () => {
		expect(issuesOf({ head: HEAD, checks: [check()] })).toEqual([]);
	});

	it("refuses one with no duration, naming the field", () => {
		const { durationMs: _, ...untimed } = check();
		expect(issuesOf({ head: HEAD, checks: [untimed] })).toEqual([
			"checks/0/durationMs: durationMs is how long the check ran, in whole milliseconds",
		]);
	});

	it("refuses a duration that is not whole milliseconds, below zero or over a day", () => {
		for (const durationMs of [1.5, -1, 86_400_001]) {
			expect(issuesOf({ head: HEAD, checks: [check({ durationMs })] })).toHaveLength(1);
		}
	});

	it("refuses one with no kind, or a kind outside the list, naming the kinds", () => {
		const { kind: _, ...unkinded } = check();
		for (const sent of [unkinded, check({ kind: "lint" })]) {
			expect(issuesOf({ head: HEAD, checks: [sent] })).toEqual([
				`checks/0/kind: kind is one of ${CHECK_KINDS.join(", ")}`,
			]);
		}
	});

	it("refuses one with no start, or no id of its own", () => {
		expect(issuesOf({ head: HEAD, checks: [check({ startedAt: "yesterday" })] })).toEqual([
			"checks/0/startedAt: startedAt is an ISO 8601 date-time",
		]);
		expect(issuesOf({ head: HEAD, checks: [check({ id: "1" })] })[0]).toContain("checks/0/id");
	});

	it("refuses one check sent twice in one list, at the second", () => {
		expect(issuesOf({ head: HEAD, checks: [check(), check({ name: "again" })] })).toEqual([
			`checks/1/id: check ${check().id} is sent twice in this list, and one check is recorded once`,
		]);
	});

	it("refuses an abbreviated head and an unknown key", () => {
		expect(issuesOf({ head: "abc1234", checks: [check()] })[0]).toContain("40 hex");
		expect(issuesOf({ head: HEAD, checks: [check({ extra: 1 })] })).toHaveLength(1);
	});

	it("is the same shape inside a merge check's report", () => {
		const report = {
			base: { branch: "dev", sha: "b".repeat(40) },
			head: HEAD,
			mode: "pre-merge",
			touched: [{ path: "a.ts", change: "changed" }],
			checks: [check({ durationMs: undefined })],
		};
		const parsed = mergeCheckReportSchema.safeParse(report);
		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues[0]?.path).toEqual(["checks", 0, "durationMs"]);
	});
});

describe("the time spent on each kind", () => {
	it("lists every kind in order, a kind nothing recorded at zero with no slowest", () => {
		const kinds = checkTimeByKind([]);
		expect(kinds.map((k) => k.kind)).toEqual([...CHECK_KINDS]);
		expect(kinds.every((k) => k.checks === 0 && k.totalMs === 0 && k.slowest === null)).toBe(
			true,
		);
	});

	it("sums each kind and names its slowest check", () => {
		const kinds = checkTimeByKind([
			{ id: "1", kind: "tests", name: "direct-tests", scope: "core", durationMs: 4000 },
			{ id: "2", kind: "tests", name: "integration-tests", scope: "core", durationMs: 9000 },
			{ id: "3", kind: "typecheck", name: "typecheck", scope: "typescript", durationMs: 3000 },
		]);
		const of = (kind: string) => kinds.find((k) => k.kind === kind);
		expect(of("tests")).toEqual({
			kind: "tests",
			checks: 2,
			totalMs: 13000,
			slowest: { id: "2", name: "integration-tests", scope: "core", durationMs: 9000 },
		});
		expect(of("typecheck")?.totalMs).toBe(3000);
		expect(of("probes")?.checks).toBe(0);
	});
});
