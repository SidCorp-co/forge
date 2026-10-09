import { describe, expect, it } from "vitest";
import {
	classifyLane,
	FAST_LANE_MERGE_CHECKS,
	FAST_LANE_REFUSAL_CODES,
	type FastLaneSettings,
	fastLaneSettingsSchema,
	globToRegExp,
} from "./fast-lane.js";
import {
	mergeCheckReportSchema,
	REQUIRED_MERGE_CHECKS,
	requiredMergeChecksOf,
} from "./merge-check.js";
import { refusalStatusOf } from "./refusal-statuses.js";

/** Forge's own declaration, as docs/proposals/live-preview.md writes it for forge-core. */
const FORGE: FastLaneSettings = {
	paths: ["packages/web-v2/src/**", "packages/web-v2/public/**"],
	kernel: ["packages/core/**", "packages/contracts/**", "packages/runner/**"],
	permissions: ["packages/web-v2/src/features/members/**"],
	deployTargets: ["web"],
};

describe("the lane a change takes, by the files it touches (BC-8)", () => {
	it("takes the fast lane for a button colour and a text in the web app", () => {
		const files = [
			"packages/web-v2/src/features/issues/components/approve-button.tsx",
			"packages/web-v2/src/features/issues/copy.json",
		];
		expect(classifyLane(files, FORGE)).toEqual({ lane: "fast", files });
	});

	it("sends a migration down the full lane, naming the file and the rule", () => {
		expect(
			classifyLane(
				[
					"packages/web-v2/src/a.tsx",
					"packages/core/drizzle/migrations/0477_previews.sql",
				],
				FORGE,
			),
		).toEqual({
			lane: "full",
			causes: [
				{
					file: "packages/core/drizzle/migrations/0477_previews.sql",
					area: "migrations",
					glob: "**/migrations/**",
				},
			],
		});
	});

	it("sends the kernel, permissions and security down the full lane even inside the web paths", () => {
		const causes = (file: string) => {
			const decision = classifyLane([file], FORGE);
			return decision.lane === "full" ? decision.causes.map((c) => c.area) : [];
		};
		expect(causes("packages/core/src/lifecycle/transition.ts")).toEqual([
			"kernel",
		]);
		expect(
			causes("packages/web-v2/src/features/members/role-select.tsx"),
		).toEqual(["permissions"]);
		expect(causes("packages/web-v2/src/lib/auth/session.ts")).toEqual([
			"security",
		]);
		expect(causes("packages/web-v2/src/middleware.ts")).toEqual(["security"]);
		expect(causes("packages/web-v2/next.config.ts")).toEqual(["security"]);
		expect(causes("packages/web-v2/package.json")).toEqual(["security"]);
		expect(causes(".github/workflows/ci.yml")).toEqual(["security"]);
		expect(causes("migrations/001.sql")).toEqual(["migrations"]);
	});

	it("sends a file outside the web-only paths down the full lane: it is not shipped by a web deploy", () => {
		expect(classifyLane(["docs/proposals/live-preview.md"], FORGE)).toEqual({
			lane: "full",
			causes: [
				{
					file: "docs/proposals/live-preview.md",
					area: "outside-fast-paths",
					glob: null,
				},
			],
		});
	});

	it("takes nothing down the fast lane for a project that declares no fast paths, or a change with no files", () => {
		expect(classifyLane(["src/a.tsx"], null)).toEqual({
			lane: "full",
			causes: [{ file: null, area: "no-fast-paths", glob: null }],
		});
		expect(
			classifyLane(["src/a.tsx"], { paths: [], deployTargets: ["web"] }),
		).toMatchObject({ lane: "full" });
		expect(classifyLane([], FORGE)).toEqual({
			lane: "full",
			causes: [{ file: null, area: "no-files", glob: null }],
		});
	});
});

describe("the glob a declaration is written in", () => {
	it("keeps * inside one directory and lets ** cross them, a leading ** also at the root", () => {
		expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
		expect(globToRegExp("src/*.ts").test("src/x/a.ts")).toBe(false);
		expect(globToRegExp("src/**").test("src/x/y/a.ts")).toBe(true);
		expect(globToRegExp("**/auth/**").test("auth/login.ts")).toBe(true);
		expect(globToRegExp("**/auth/**").test("a/b/auth/login.ts")).toBe(true);
		expect(globToRegExp("**/auth/**").test("a/oauth/login.ts")).toBe(false);
		expect(globToRegExp("**/.env.*").test("web/.env.local")).toBe(true);
		expect(globToRegExp("a.b").test("axb")).toBe(false);
	});
});

describe("the fast lane's checks and refusals (BC-7)", () => {
	it("are typecheck and the touched tests on the latest base, a subset of the full lane's", () => {
		expect([...FAST_LANE_MERGE_CHECKS]).toEqual([
			"rebased-on-base",
			"typecheck",
			"direct-tests",
		]);
		for (const check of FAST_LANE_MERGE_CHECKS)
			expect(REQUIRED_MERGE_CHECKS).toContain(check);
	});

	it("answer the status their meaning picks", () => {
		expect(
			Object.fromEntries(
				FAST_LANE_REFUSAL_CODES.map((c) => [c, refusalStatusOf(c)]),
			),
		).toEqual({
			FAST_LANE_NOT_ELIGIBLE: 422,
			FAST_LANE_NOT_APPROVED: 409,
			FAST_LANE_CHANGED_SINCE_APPROVAL: 409,
			FAST_LANE_UNDECLARED: 422,
			FAST_LANE_UNVERIFIED: 503,
		});
	});

	it("needs a deploy target to ship to", () => {
		expect(
			fastLaneSettingsSchema.safeParse({ paths: ["src/**"], deployTargets: [] })
				.success,
		).toBe(false);
		expect(fastLaneSettingsSchema.safeParse(FORGE).success).toBe(true);
	});
});

describe("a merge check report on the fast lane (BC-7)", () => {
	const SHA = "a".repeat(40);
	const report = (over: Record<string, unknown>) => ({
		base: { branch: "dev", sha: "b".repeat(40) },
		head: SHA,
		mode: "pre-merge",
		touched: [{ path: "packages/web-v2/src/a.tsx", change: "changed" }],
		checks: [
			{
				id: "6f1c1d1e-7f4a-4a54-9f3c-2b8a2b0f1a11",
				kind: "typecheck",
				name: "typecheck",
				scope: "workspace",
				command: "tsc",
				files: [],
				result: "pass",
				durationMs: 1,
				startedAt: "2026-10-09T06:00:00.000Z",
			},
		],
		...over,
	});
	const paths = (over: Record<string, unknown>) => {
		const parsed = mergeCheckReportSchema.safeParse(report(over));
		return parsed.success
			? []
			: parsed.error.issues.map((i) => i.path.join("."));
	};

	it("needs only the fast checks, and every check a merge needs without a lane", () => {
		expect(requiredMergeChecksOf("fast")).toEqual(FAST_LANE_MERGE_CHECKS);
		expect(requiredMergeChecksOf("full")).toEqual(REQUIRED_MERGE_CHECKS);
		expect(requiredMergeChecksOf(undefined)).toEqual(REQUIRED_MERGE_CHECKS);
	});

	it("names the patch id of what it checked, and only there", () => {
		expect(paths({ lane: "fast", patchId: "c".repeat(40) })).toEqual([]);
		expect(paths({ lane: "fast" })).toEqual(["patchId"]);
		expect(paths({ lane: "full", patchId: "c".repeat(40) })).toEqual([
			"patchId",
		]);
		expect(paths({ patchId: "c".repeat(40) })).toEqual(["patchId"]);
		expect(paths({ lane: "fast", patchId: "C".repeat(40) })).toEqual([
			"patchId",
		]);
		expect(paths({})).toEqual([]);
	});

	it("refuses a lane that is not one", () => {
		expect(paths({ lane: "express" })).toEqual(["lane"]);
	});
});
