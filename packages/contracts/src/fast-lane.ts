// The fast lane (REQ-39 BC-7, BC-8; docs/proposals/live-preview.md, "Fast lane"): a change a person
// approved in its live preview lands with typecheck, the touched files' direct tests and a merge,
// then a web-only deploy. Forge picks the lane from the files the change touches, never the run:
// a file in the kernel, a migration, permissions or security sends it down the full lane, and so
// does any file outside the paths the project declares deployable web-only.

import { z } from "zod";
import type { RequiredMergeCheck } from "./merge-check.js";
import type { RefusalStatuses } from "./refusal.js";

export const LANES = ["fast", "full"] as const;
export type Lane = (typeof LANES)[number];

/**
 * What keeps the full gates whatever the project declares (BC-8), in the order a file is named by:
 * the specific areas before the kernel, whose declaration is usually a whole package.
 */
export const FULL_GATE_AREAS = [
	"migrations",
	"permissions",
	"security",
	"kernel",
] as const;
export type FullGateArea = (typeof FULL_GATE_AREAS)[number];

/**
 * The paths every project's change is held to the full lane by, before its own declaration adds
 * more. Globs are matched against the whole repository-relative path: `*` stays inside one
 * directory, `**` crosses them, and a leading `**` segment also matches at the root. The kernel has no
 * generic shape, so it is the project's to declare.
 */
export const BUILT_IN_FULL_GATE_PATHS: Readonly<
	Record<FullGateArea, readonly string[]>
> = {
	migrations: [
		"**/migrations/**",
		"**/drizzle/**",
		"**/*.sql",
		"**/schema.prisma",
	],
	permissions: [
		"**/permissions/**",
		"**/permissions.*",
		"**/rbac/**",
		"**/acl/**",
	],
	security: [
		"**/auth/**",
		"**/credentials/**",
		"**/secrets/**",
		"**/security/**",
		"**/middleware.ts",
		"**/middleware.js",
		"**/.env",
		"**/.env.*",
		"**/Dockerfile",
		"**/Dockerfile.*",
		".github/**",
		"**/package.json",
		"**/pnpm-lock.yaml",
		"**/package-lock.json",
		"**/yarn.lock",
		"**/next.config.*",
		"**/vite.config.*",
	],
	kernel: [],
};

const glob = z.string().trim().min(1).max(200);
const globs = z.array(glob).max(50);

/**
 * The project's fast-lane declaration, a key of the project document. `paths` are the files a
 * web-only deploy ships (empty: nothing takes the fast lane); the area lists add to the built-in
 * ones; `deployTargets` are the labels of the deploy binding's targets a web-only deploy fans out
 * to, and nothing else.
 */
export const fastLaneSettingsSchema = z.strictObject({
	paths: globs,
	kernel: globs.optional(),
	migrations: globs.optional(),
	permissions: globs.optional(),
	security: globs.optional(),
	deployTargets: z.array(z.string().min(1).max(60)).min(1).max(5),
});
export type FastLaneSettings = z.infer<typeof fastLaneSettingsSchema>;

/** Why a change is on the full lane, one row per file and the rule that caught it. */
export type FullLaneCause =
	| { file: string; area: FullGateArea; glob: string }
	| { file: string; area: "outside-fast-paths"; glob: null }
	| { file: null; area: "no-fast-paths" | "no-files"; glob: null };

export type LaneDecision =
	| { lane: "fast"; files: string[] }
	| { lane: "full"; causes: FullLaneCause[] };

/** Anchored at both ends, as `scripts/lib/gate.mjs:globToRegExp`, with a `**` segment also matching no directory. */
export function globToRegExp(pattern: string): RegExp {
	let body = "";
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern.charAt(i);
		if (c === "*" && pattern.charAt(i + 1) === "*") {
			if (pattern.charAt(i + 2) === "/") {
				body += "(?:.*/)?";
				i += 2;
			} else {
				body += ".*";
				i += 1;
			}
		} else if (c === "*") body += "[^/]*";
		else if (c === "?") body += "[^/]";
		else body += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${body}$`);
}

/**
 * The lane a change takes, from the files it touches (BC-8). Every file must sit inside the
 * project's fast paths and outside every full-gate area; each that does not is named with the rule
 * that caught it, so the issue says why the change took the long way.
 */
export function classifyLane(
	files: readonly string[],
	settings: FastLaneSettings | null,
): LaneDecision {
	if (files.length === 0)
		return {
			lane: "full",
			causes: [{ file: null, area: "no-files", glob: null }],
		};
	const fastPaths = (settings?.paths ?? []).map(globToRegExp);
	if (fastPaths.length === 0) {
		return {
			lane: "full",
			causes: [{ file: null, area: "no-fast-paths", glob: null }],
		};
	}
	const areas = FULL_GATE_AREAS.flatMap((area) =>
		[...BUILT_IN_FULL_GATE_PATHS[area], ...(settings?.[area] ?? [])].map(
			(g) => ({
				area,
				glob: g,
				re: globToRegExp(g),
			}),
		),
	);
	const causes: FullLaneCause[] = [];
	for (const file of files) {
		const caught = areas.find((a) => a.re.test(file));
		if (caught) causes.push({ file, area: caught.area, glob: caught.glob });
		else if (!fastPaths.some((re) => re.test(file))) {
			causes.push({ file, area: "outside-fast-paths", glob: null });
		}
	}
	return causes.length === 0
		? { lane: "fast", files: [...files] }
		: { lane: "full", causes };
}

/** The merge checks the fast lane runs: the rest of `REQUIRED_MERGE_CHECKS` belong to the full lane. */
export const FAST_LANE_MERGE_CHECKS = [
	"rebased-on-base",
	"typecheck",
	"direct-tests",
] as const satisfies readonly RequiredMergeCheck[];

export const FAST_LANE_REFUSAL_CODES = [
	/** The change touches a file the fast lane does not take; the causes are listed. */
	"FAST_LANE_NOT_ELIGIBLE",
	/** No approved preview of this issue. */
	"FAST_LANE_NOT_APPROVED",
	/** The change merged is not the change approved: its patch id differs from the approved one. */
	"FAST_LANE_CHANGED_SINCE_APPROVAL",
	/** The project declares no fast lane, or no deploy target for it. */
	"FAST_LANE_UNDECLARED",
] as const;
export type FastLaneRefusalCode = (typeof FAST_LANE_REFUSAL_CODES)[number];

export const FAST_LANE_REFUSAL_STATUSES = {
	FAST_LANE_NOT_APPROVED: 409,
	FAST_LANE_CHANGED_SINCE_APPROVAL: 409,
} as const satisfies RefusalStatuses<FastLaneRefusalCode>;
