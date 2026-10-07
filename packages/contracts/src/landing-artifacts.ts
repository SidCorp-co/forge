import { z } from "zod";

/** Where a landed change takes effect. `design` is a design revision: it deploys nothing. */
export const LANDING_SURFACES = [
	"ui",
	"api",
	"logic",
	"data",
	"config",
	"runner",
	"design",
] as const;
export type LandingSurface = (typeof LANDING_SURFACES)[number];

const ARTIFACT_CHANGES = ["added", "changed", "removed"] as const;
export type ArtifactChange = (typeof ARTIFACT_CHANGES)[number];

export const LANDING_SURFACE_LABELS: Readonly<Record<LandingSurface, string>> =
	{
		ui: "UI",
		api: "API",
		logic: "Logic",
		data: "Data",
		config: "Config",
		runner: "Runner",
		design: "Design",
	};

export const ARTIFACT_CHANGE_LABELS: Readonly<Record<ArtifactChange, string>> =
	{
		added: "Added",
		changed: "Changed",
		removed: "Removed",
	};

/** The surfaces whose artifacts ship nothing: a release carrying only these deploys no change. */
export const SHIPS_NOTHING: readonly LandingSurface[] = ["design"];

export interface LandingArtifact {
	surface: LandingSurface;
	/** What changed: a screen, a route, a table, a workflow, a file path. */
	ref: string;
	change: ArtifactChange;
}

const oneOf = (values: readonly string[]) =>
	values.map((v) => `\`${v}\``).join(", ");

const LANDING_ARTIFACTS_MAX = 200;

const landingArtifactSchema = z.strictObject({
	surface: z.enum(LANDING_SURFACES, {
		error: (issue) =>
			`surface ${JSON.stringify(issue.input)} is not a landing surface: it is one of ${oneOf(LANDING_SURFACES)}`,
	}),
	ref: z
		.string()
		.trim()
		.min(
			1,
			"ref names what changed: a screen, a route, a table, a workflow or a path",
		)
		.max(300, "ref is at most 300 characters"),
	change: z.enum(ARTIFACT_CHANGES, {
		error: (issue) =>
			`change ${JSON.stringify(issue.input)} is not an artifact change: it is one of ${oneOf(ARTIFACT_CHANGES)}`,
	}),
});

export const landingArtifactsSchema = z
	.array(landingArtifactSchema)
	.min(
		1,
		"artifacts names at least one; leave it out where the landing names none",
	)
	.max(
		LANDING_ARTIFACTS_MAX,
		`artifacts names at most ${LANDING_ARTIFACTS_MAX}`,
	);

const CHANGED_PATHS_MAX = 2000;

/** One file a commit changed and what became of it; a rename is its old path removed and new added. */
export interface FileChange {
	path: string;
	change: ArtifactChange;
}

/**
 * The paths a commit changed, read by the box from its own checkout (`git diff <first parent>
 * <commit> --name-status`) and sent with a mark by `forge-runner api`, for a project whose source
 * host Forge cannot read. Core classifies them by the project's `surfaces` and labels them box-read:
 * the box's reading, not a merge Forge observed.
 */
export const changedPathsSchema = z.strictObject({
	commit: z
		.string()
		.trim()
		.regex(
			/^[0-9a-f]{7,64}$/i,
			"changedPaths.commit is the git sha the paths were read at",
		),
	changes: z
		.array(
			z.strictObject({
				path: z.string().min(1).max(1000),
				change: z.enum(ARTIFACT_CHANGES, {
					error: (issue) =>
						`change ${JSON.stringify(issue.input)} is not a file change: it is one of ${oneOf(ARTIFACT_CHANGES)}`,
				}),
			}),
		)
		.max(
			CHANGED_PATHS_MAX,
			`changedPaths names at most ${CHANGED_PATHS_MAX} files`,
		),
});

/** What `issues.merged_paths` holds: the paths, the commit they were read at, and who read them. */
export interface ReadPaths {
	commit: string;
	read: "box";
	changes: FileChange[];
}

const DESIGN_TOKEN = /^forge-workflow:([^\s@()]+@rev\d+)/;
const DESIGN_SENTENCE = /^workflow design `([^`]+)` revision (\d+), approved$/;

/**
 * The design revision a landing names, as `<flow>@rev<n>`, or null where it names none. A landing
 * written as `forge-workflow:<flow>@rev<n>` or by the approval of a revision is one; any other text
 * is prose this reads nothing from.
 */
export function designLandingRef(
	landing: string | null | undefined,
): string | null {
	const text = (landing ?? "").trim();
	const token = DESIGN_TOKEN.exec(text);
	if (token?.[1]) return token[1];
	const sentence = DESIGN_SENTENCE.exec(text);
	return sentence ? `${sentence[1]}@rev${sentence[2]}` : null;
}

/** The artifact a design revision is: surface `design`, which ships nothing. */
export function designArtifact(ref: string): LandingArtifact {
	return { surface: "design", ref, change: "changed" };
}
