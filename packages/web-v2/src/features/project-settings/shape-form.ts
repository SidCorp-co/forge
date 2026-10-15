// The project's shape as a person declares it, and the two stored fields it is written as. Four
// shapes, each a pair of `kind` and the release chain's length; a stored pair that is none of them
// is a clash this screen names and never maps onto the nearest shape.

import { z } from "zod";
import type { ProjectDetail } from "@/features/projects/types";
import type {
	ProjectKind,
	ProjectUpdateInput,
	ReleaseChainEntry,
	ReleaseCrossing,
	ReleaseReadiness,
} from "./types";

export type Shape = "no-repository" | "no-release" | "publish" | "promote";

export const SHAPES: readonly { value: Shape; label: string; hint: string }[] = [
	{
		value: "no-repository",
		label: "No repository",
		hint: "Work happens through an API or a CMS. Nothing lands in git, so there are no branches and no release path.",
	},
	{
		value: "no-release",
		label: "Repository, no release",
		hint: "Work lands in git and is finished when it lands. Issues close without waiting for a release.",
	},
	{
		value: "publish",
		label: "Publish to a live target",
		hint: "A release deploys the base branch to the live target. No branch moves.",
	},
	{
		value: "promote",
		label: "Promote through branches",
		hint: "A release carries the base branch into one or more later branches, then deploys the last one.",
	},
];

/** The statuses whose work a shape change re-routes: started and not yet closed. */
export const IN_FLIGHT = ["in_progress", "developed", "testing", "awaiting_release"] as const;

/** Every entry after the first. The first is always the base branch, so it is not edited twice. */
export interface Hop {
	branch: string;
	from: ReleaseCrossing;
}

export interface ShapeDraft {
	/** `null` where the stored kind and chain are none of the four, until a person picks one. */
	shape: Shape | null;
	repoPath: string;
	repoUrl: string;
	workspaceSetup: string;
	baseBranch: string;
	hops: Hop[];
	/** The tag pattern the live entry names. This screen shows no field for it and hands it back. */
	releaseTag?: string;
}

const KIND_OF: Record<Shape, ProjectKind> = {
	"no-repository": "website",
	"no-release": "standard",
	publish: "standard",
	promote: "standard",
};

export function shapeOf(kind: string, chain: readonly ReleaseChainEntry[]): Shape | null {
	if (kind === "website") return chain.length === 0 ? "no-repository" : null;
	if (kind !== "standard") return null;
	if (chain.length === 0) return "no-release";
	return chain.length === 1 ? "publish" : "promote";
}

/** What a stored pair that fits no shape is, said so a person can choose. */
export function shapeClash(kind: string, chain: readonly ReleaseChainEntry[]): string | null {
	if (shapeOf(kind, chain) !== null) return null;
	if (kind === "website") {
		return `This project is declared as having no repository (kind \`website\`), and it also declares a release path through ${chain.map((e) => `\`${e.branch}\``).join(", ")}. A release path is a path between git branches, so the two cannot both be true. Pick the shape it really has.`;
	}
	return `This project's kind is \`${kind}\`, which Forge does not know, so it cannot say how its work lands. Pick the shape it really has.`;
}

const norm = (v: string) => (v.trim() === "" ? null : v.trim());

function hopsOf(chain: readonly ReleaseChainEntry[]): Hop[] {
	return chain.slice(1).map((e) => ({ branch: e.branch, from: e.from ?? "merge-branch" }));
}

export function readShape(project: ProjectDetail): ShapeDraft {
	const chain = (project.releaseChain ?? []) as ReleaseChainEntry[];
	return {
		shape: shapeOf(project.kind, chain),
		repoPath: project.repoPath ?? "",
		repoUrl: project.repoUrl ?? "",
		workspaceSetup: project.workspaceSetup ?? "",
		baseBranch: project.baseBranch ?? "",
		hops: hopsOf(chain),
		releaseTag: chain[chain.length - 1]?.tag,
	};
}

/** The chain a draft stands for. A clash keeps the stored chain until a shape is picked. The tag
 *  belongs to whichever entry is live now, and a project that ships nothing declares none. */
export function chainOf(d: ShapeDraft, stored: readonly ReleaseChainEntry[]): ReleaseChainEntry[] {
	if (d.shape === null) return [...stored];
	const base = norm(d.baseBranch);
	let entries: ReleaseChainEntry[] = [];
	if ((d.shape === "publish" || d.shape === "promote") && base !== null) {
		entries = [{ branch: base }];
		if (d.shape === "promote") {
			entries.push(
				...d.hops
					.filter((h) => h.branch.trim() !== "")
					.map((h) => ({ branch: h.branch.trim(), from: h.from })),
			);
		}
	}
	const last = entries.length - 1;
	return d.releaseTag === undefined || last < 0
		? entries
		: entries.map((e, i) => (i === last ? { ...e, tag: d.releaseTag } : e));
}

export function kindOf(d: ShapeDraft, storedKind: string): string {
	return d.shape === null ? storedKind : KIND_OF[d.shape];
}

/** A chain as its meaning, not its key order: the server's jsonb hands entries back reordered. */
export function chainKey(chain: readonly ReleaseChainEntry[]): string {
	return JSON.stringify(chain.map((e) => [e.branch, e.from ?? null, e.tag ?? null]));
}

export function shapeComparable(project: ProjectDetail) {
	const stored = (project.releaseChain ?? []) as ReleaseChainEntry[];
	return (d: ShapeDraft) => ({
		kind: kindOf(d, project.kind),
		chain: chainKey(chainOf(d, stored)),
		repoPath: norm(d.repoPath),
		repoUrl: norm(d.repoUrl),
		workspaceSetup: norm(d.workspaceSetup),
		baseBranch: norm(d.baseBranch),
		hops: d.shape === "promote" ? d.hops : [],
	});
}

/** The PATCH a held draft sends: only what moved. A base branch that moves takes the chain's first
 *  entry with it, so the two go up together rather than reaching a server that refuses the pair. */
export function shapePatch(held: ShapeDraft, project: ProjectDetail): ProjectUpdateInput {
	const stored = (project.releaseChain ?? []) as ReleaseChainEntry[];
	const chain = chainOf(held, stored);
	const patch: ProjectUpdateInput = {};
	const kind = kindOf(held, project.kind);
	if (kind !== project.kind) patch.kind = kind as ProjectKind;
	if (norm(held.repoPath) !== (project.repoPath ?? null)) patch.repoPath = norm(held.repoPath);
	if (norm(held.repoUrl) !== (project.repoUrl ?? null)) patch.repoUrl = norm(held.repoUrl);
	if (norm(held.workspaceSetup) !== (project.workspaceSetup ?? null)) {
		patch.workspaceSetup = norm(held.workspaceSetup);
	}
	const baseMoved = norm(held.baseBranch) !== (project.baseBranch ?? null);
	if (baseMoved) patch.baseBranch = norm(held.baseBranch);
	if (chainKey(chain) !== chainKey(stored) || (baseMoved && chain.length > 0)) {
		patch.releaseChain = chain;
	}
	return patch;
}

/** Whether a held draft changes which shape the project has. */
export function shapeMoved(held: ShapeDraft, project: ProjectDetail): boolean {
	const stored = (project.releaseChain ?? []) as ReleaseChainEntry[];
	return held.shape !== shapeOf(project.kind, stored);
}

export const SHAPE_MESSAGES = {
	noShape: "Pick the shape this project has before saving.",
	noBase: "A release starts at the base branch. Name it, for example main, or pick a shape with no release.",
	noHop: "Promote needs at least one branch after the base branch. Add one, or pick Publish.",
	repeated:
		"The same branch appears twice, so the release would cross into a branch it has already left. Rename one of them, or remove it.",
} as const;

export function shapeSchema(project: ProjectDetail): z.ZodType<ShapeDraft, ShapeDraft> {
	const stored = (project.releaseChain ?? []) as ReleaseChainEntry[];
	return z
		.object({
			shape: z.enum(["no-repository", "no-release", "publish", "promote"]).nullable(),
			repoPath: z.string(),
			repoUrl: z.string(),
			workspaceSetup: z.string(),
			baseBranch: z.string(),
			hops: z.array(z.object({ branch: z.string(), from: z.enum(["merge-branch", "cherry-pick"]) })),
			releaseTag: z.string().optional(),
		})
		.superRefine((d, ctx) => {
			// A clash nobody has touched is the stored state, not an edit; it is refused only once a
			// person edits something else on top of it, which `shapePatch` would then send.
			if (d.shape === null) return;
			if ((d.shape === "publish" || d.shape === "promote") && norm(d.baseBranch) === null) {
				ctx.addIssue({ code: "custom", path: ["baseBranch"], message: SHAPE_MESSAGES.noBase });
			}
			if (d.shape === "promote" && d.hops.every((h) => h.branch.trim() === "")) {
				ctx.addIssue({ code: "custom", path: ["hops"], message: SHAPE_MESSAGES.noHop });
			}
			const chain = chainOf(d, stored);
			if (new Set(chain.map((e) => e.branch)).size !== chain.length) {
				ctx.addIssue({ code: "custom", path: ["hops"], message: SHAPE_MESSAGES.repeated });
			}
		}) as unknown as z.ZodType<ShapeDraft, ShapeDraft>;
}

/** The one-line answer to "can this project release?", read off the stored declaration. */
export type ReleaseAnswer =
	| { kind: "unread" }
	| { kind: "ships-nothing" }
	| { kind: "blocked"; count: number }
	| { kind: "undeclared"; count: number }
	| { kind: "ready" };

/** An unread declaration is never a project that ships nothing, and a gap never stops a release. */
export function releaseAnswer(r: ReleaseReadiness): ReleaseAnswer {
	if (!r.declarationRead) return { kind: "unread" };
	if (r.releaseChain.length === 0) return { kind: "ships-nothing" };
	if (r.blockers.length > 0) return { kind: "blocked", count: r.blockers.length };
	if (r.gaps.length > 0) return { kind: "undeclared", count: r.gaps.length };
	return { kind: "ready" };
}
