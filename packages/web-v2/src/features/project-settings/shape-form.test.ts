// The shape model away from the screen: which of four a stored pair is, what a draft writes, and
// the one-line answer read off the release declaration. The release-tag cases carry ISS-1391's from
// the Repository tab this replaced: the chain is rebuilt from the page's fields on every save, so a
// `tag` it did not hand back would be dropped in silence.

import { describe, expect, it } from "vitest";
import type { ProjectDetail } from "@/features/projects/types";
import {
	chainOf,
	readShape,
	releaseAnswer,
	type ShapeDraft,
	shapeClash,
	shapeMoved,
	shapeOf,
	shapePatch,
} from "./shape-form";
import type { ReleaseChainEntry, ReleaseReadiness } from "./types";

function project(releaseChain: ReleaseChainEntry[], over: Record<string, unknown> = {}): ProjectDetail {
	return {
		id: "p1",
		kind: "standard",
		repoPath: "/srv/desk",
		repoUrl: null,
		workspaceSetup: null,
		baseBranch: "dev",
		releaseChain,
		...over,
	} as unknown as ProjectDetail;
}

const edit = (p: ProjectDetail, change: Partial<ShapeDraft>) => shapePatch({ ...readShape(p), ...change }, p);

describe("shapeOf", () => {
	it("reads each of the four shapes off kind and chain length", () => {
		expect(shapeOf("website", [])).toBe("no-repository");
		expect(shapeOf("standard", [])).toBe("no-release");
		expect(shapeOf("standard", [{ branch: "main" }])).toBe("publish");
		expect(shapeOf("standard", [{ branch: "dev" }, { branch: "main", from: "merge-branch" }])).toBe("promote");
	});

	it("reads no shape for a website project that declares a chain, or a kind Forge does not know", () => {
		expect(shapeOf("website", [{ branch: "main" }])).toBeNull();
		expect(shapeOf("kiosk", [])).toBeNull();
		expect(shapeClash("website", [{ branch: "main" }])).toMatch(/`main`/);
		expect(shapeClash("standard", [])).toBeNull();
	});
});

describe("shapePatch", () => {
	it("writes kind and an empty chain for No repository", () => {
		expect(edit(project([{ branch: "dev" }]), { shape: "no-repository" })).toEqual({
			kind: "website",
			releaseChain: [],
		});
	});

	it("writes only the chain for Repository, no release", () => {
		expect(edit(project([{ branch: "dev" }]), { shape: "no-release" })).toEqual({ releaseChain: [] });
	});

	it("writes nothing for a clash nobody touched", () => {
		const p = project([{ branch: "main" }], { kind: "website" });
		expect(readShape(p).shape).toBeNull();
		expect(shapePatch(readShape(p), p)).toEqual({});
		expect(shapeMoved(readShape(p), p)).toBe(false);
	});

	it("sends no chain where only the repository path changed", () => {
		expect(edit(project([{ branch: "dev", tag: "v*.*.*" }]), { repoPath: "/srv/desk2" })).toEqual({
			repoPath: "/srv/desk2",
		});
	});

	it("keeps the tag on the first entry when the base branch moves and the chain goes up with it", () => {
		expect(edit(project([{ branch: "dev", tag: "v*.*.*" }]), { baseBranch: "main" })).toEqual({
			baseBranch: "main",
			releaseChain: [{ branch: "main", tag: "v*.*.*" }],
		});
	});

	it("moves the tag to the new last entry when the project starts promoting", () => {
		expect(
			edit(project([{ branch: "dev", tag: "v*" }]), {
				shape: "promote",
				hops: [{ branch: "production", from: "merge-branch" }],
			}),
		).toEqual({
			releaseChain: [{ branch: "dev" }, { branch: "production", from: "merge-branch", tag: "v*" }],
		});
	});

	it("keeps the tag on the last entry of a chain it did not edit, when the base branch moves", () => {
		const p = project([{ branch: "dev" }, { from: "merge-branch", branch: "main", tag: "v*" } as ReleaseChainEntry]);
		expect(edit(p, { baseBranch: "trunk" }).releaseChain).toEqual([
			{ branch: "trunk" },
			{ branch: "main", from: "merge-branch", tag: "v*" },
		]);
	});

	it("puts no tag on the wire for a project that declared none", () => {
		expect(edit(project([{ branch: "dev" }]), { baseBranch: "main" })).toEqual({
			baseBranch: "main",
			releaseChain: [{ branch: "main" }],
		});
	});

	it("drops a promotion row with no name, and a chain that crosses nothing is a publish", () => {
		const d = { ...readShape(project([{ branch: "dev" }])), shape: "promote" as const, hops: [{ branch: " ", from: "merge-branch" as const }] };
		expect(chainOf(d, [])).toEqual([{ branch: "dev" }]);
	});
});

function readiness(over: Partial<ReleaseReadiness>): ReleaseReadiness {
	return {
		releaseChain: [{ branch: "main" }],
		declarationRead: true,
		blockers: [],
		gaps: [],
		...over,
	} as ReleaseReadiness;
}

describe("releaseAnswer", () => {
	const blocker = { code: "RELEASE_ROSTER_EMPTY", evaluated: true, message: "Nothing waits." };

	it("never reads an unread declaration as a project that ships nothing", () => {
		expect(releaseAnswer(readiness({ declarationRead: false, releaseChain: [] }))).toEqual({ kind: "unread" });
	});

	it("says a project with an empty chain ships nothing", () => {
		expect(releaseAnswer(readiness({ releaseChain: [] }))).toEqual({ kind: "ships-nothing" });
	});

	it("counts what stops a release, before anything undeclared", () => {
		expect(releaseAnswer(readiness({ blockers: [blocker, blocker], gaps: ["rollback"] }))).toEqual({
			kind: "blocked",
			count: 2,
		});
	});

	it("never counts a gap as stopping a release", () => {
		expect(releaseAnswer(readiness({ gaps: ["rollback", "verify-probes"] }))).toEqual({
			kind: "undeclared",
			count: 2,
		});
	});

	it("says a release can start where nothing stops it and nothing is undeclared", () => {
		expect(releaseAnswer(readiness({}))).toEqual({ kind: "ready" });
	});
});
