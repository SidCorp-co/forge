import { describe, expect, it } from "vitest";
import { cleanupReportRequestSchema, debtItemSchema, impactSchema, IMPACT_TYPES } from "./cleanup.js";
import { deliveryPolicySchema, fastDeliveryOf } from "./delivery-policy.js";
import { LANDING_SURFACES } from "./landing-artifacts.js";
import { mergeCheckReportSchema, requiredMergeChecksOf, REQUIRED_MERGE_CHECKS } from "./merge-check.js";
import { FAST_LANE_MERGE_CHECKS } from "./fast-lane.js";

const impact = { type: "data", rating: "medium", reason: "a column read in one place" } as const;

describe("fast delivery is every project's default (REQ-79 BC-1)", () => {
	it("is on where the policy says nothing, and off only where it says fast: false", () => {
		expect(fastDeliveryOf(undefined)).toBe(true);
		expect(fastDeliveryOf({})).toBe(true);
		expect(fastDeliveryOf({ verdictsRequired: false })).toBe(true);
		expect(fastDeliveryOf({ fast: true })).toBe(true);
		expect(fastDeliveryOf({ fast: false })).toBe(false);
	});

	it("is a boolean on the delivery policy, and nothing else", () => {
		expect(deliveryPolicySchema.safeParse({ fast: false }).success).toBe(true);
		expect(deliveryPolicySchema.safeParse({ fast: "off" }).success).toBe(false);
	});
});

describe("a merge on a project delivering fast asks build and scoped tests (REQ-79 BC-2)", () => {
	it("needs the three fast checks where fast delivery is on, every check where it is off", () => {
		expect(requiredMergeChecksOf(undefined, true)).toEqual(FAST_LANE_MERGE_CHECKS);
		expect(requiredMergeChecksOf(undefined, false)).toEqual(REQUIRED_MERGE_CHECKS);
		expect(requiredMergeChecksOf(undefined)).toEqual(REQUIRED_MERGE_CHECKS);
	});
});

describe("an impact rating (REQ-79 BC-4)", () => {
	it("types a change by the surface its paths map to, never design or adoption", () => {
		expect([...IMPACT_TYPES].sort()).toEqual(
			LANDING_SURFACES.filter((s) => s !== "design" && s !== "adoption").sort(),
		);
	});

	it("takes a type, a rating and a reason, and refuses an unknown type by naming the types", () => {
		expect(impactSchema.safeParse(impact).success).toBe(true);
		const wrong = impactSchema.safeParse({ ...impact, type: "database" });
		expect(wrong.success).toBe(false);
		expect(JSON.stringify(wrong.error)).toContain("ui, api, logic, data, config, runner");
		expect(impactSchema.safeParse({ ...impact, rating: "severe" }).success).toBe(false);
		expect(impactSchema.safeParse({ ...impact, reason: "  " }).success).toBe(false);
	});
});

describe("cleanup debt (REQ-79 BC-3)", () => {
	it("names the check a red ended on", () => {
		expect(debtItemSchema.safeParse({ kind: "red", where: "core", detail: "x", impact }).success).toBe(false);
		expect(
			debtItemSchema.safeParse({ kind: "red", check: "verify", where: "core", detail: "x", impact }).success,
		).toBe(true);
		expect(debtItemSchema.safeParse({ kind: "simplify", where: "core", detail: "x", impact }).success).toBe(true);
	});

	it("is refused in a merge check where a red is rated high: that red holds the change", () => {
		const report = {
			base: { branch: "dev", sha: "b".repeat(40) },
			head: "a".repeat(40),
			mode: "pre-merge",
			touched: [{ path: "x.ts", change: "changed" }],
			checks: [
				{
					id: "5d1c7d4e-2f0a-4b8e-9c1d-2e3f4a5b6c7d",
					kind: "conformance",
					startedAt: "2026-10-30T06:00:00.000Z",
					name: "verify",
					scope: "workspace",
					command: "pnpm verify",
					files: [],
					result: "fail",
					durationMs: 1000,
				},
			],
			debts: [{ kind: "red", check: "verify", where: "core", detail: "x", impact: { ...impact, rating: "high" } }],
		};
		const parsed = mergeCheckReportSchema.safeParse(report);
		expect(parsed.success).toBe(false);
		expect(JSON.stringify(parsed.error)).toContain("holds the change");
		const medium = mergeCheckReportSchema.safeParse({ ...report, debts: [{ ...report.debts[0], impact }] });
		expect(medium.success).toBe(true);
	});
});

describe("a cleanup report (REQ-79 BC-9)", () => {
	it("says what it cleared and what remains, each with its words", () => {
		const debt = "0b6a9f3e-4b9a-4a59-8f4a-1c1d1e1f1a1b";
		const ok = cleanupReportRequestSchema.safeParse({
			base: { branch: "dev", sha: "c".repeat(40) },
			result: "green",
			cleared: [{ debt, how: "fixed the flaky wait" }],
			remains: [],
		});
		expect(ok.success).toBe(true);
		const mute = cleanupReportRequestSchema.safeParse({
			base: { branch: "dev", sha: "c".repeat(40) },
			result: "green",
			cleared: [],
			remains: [{ debt, why: "" }],
		});
		expect(mute.success).toBe(false);
	});
});
