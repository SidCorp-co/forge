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
	/**
	 * The issue (its key, in the same project) whose own release ships this artifact: the landing
	 * touched it, but it is that issue's to ship. Said explicitly on the mark, never inferred; a
	 * release of this issue reports it carried, and the carrier's release verifies it.
	 */
	carriedBy?: string | undefined;
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
	carriedBy: z
		.string()
		.trim()
		.min(1, "carriedBy names the issue whose own release ships this artifact")
		.max(64, "carriedBy is an issue key or id")
		.optional(),
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

/**
 * What a storefront provider can attest of a landing, read from one artifact's `ref`: a backend
 * workflow (and the graph it was drafted at, where named), a route, a page, a theme (with the files
 * and their sha-256 where named), or a store setting's value. Anything else — a table, test rows, a
 * domain — is a change the provider reports no state for.
 */
export type StorefrontArtifact =
	| { kind: "workflow"; id: string; graph: string | null }
	| { kind: "route"; id: string }
	| { kind: "page"; id: string }
	| { kind: "theme"; id: string; files: StorefrontThemeFile[] }
	| { kind: "setting"; key: string; value: string };

export type StorefrontArtifactKind = StorefrontArtifact["kind"];

export interface StorefrontThemeFile {
	path: string;
	/** The file's sha-256 (or a prefix of at least 8 hex) as the landing named it, else null. */
	checksum: string | null;
}

/**
 * The grammar a storefront artifact's `ref` is written in, said once where a mark is refused or a
 * landing is read: what an artifact names first decides its kind.
 */
export const STOREFRONT_ARTIFACT_GRAMMAR =
	"`workflow <id> [@<graph sha-256>]`, `route <id>`, `page <id>`, `theme <id> [<path> [sha256 <hex>]]…` or `setting <key> = <value>`, optionally after `draft`";

const HEX = /^[0-9a-f]{8,64}$/i;
const SUBJECT =
	/^(?:(?:ui|api|logic|data|config):\s*)?(?:https?:\/\/\S+\s+(?:served by|on)\s+)?(?:autoflow(?:\s+[\w-]+)?\s+)?(?:(?:draft|live|served|published)\s+)?(workflow|route|page|theme)\s+(\d+)\b([\s\S]*)$/i;
const SETTING =
	/^(?:setting|config)s?\s*:?\s+(?:store\s+\S+\s+)?([A-Za-z_][\w.]*)\s*(?:=|:|\bis\b|\bto\b)?\s*("[^"]*"|\S+)\s*$/i;
const THEME_FILE =
	/\b((?:assets|sections|snippets|templates|layout|config|locales|blocks)\/[\w.\-/]*[\w-])(?:\s*(?:\(\s*)?(?:@|sha256|sha-256)?\s*([0-9a-f]{8,64})\b)?/gi;

/** The first token of 8 to 64 hex an artifact names: the graph a workflow landed at. */
function firstHex(text: string): string | null {
	for (const token of text.split(/[\s@(),:;]+/)) {
		if (HEX.test(token)) return token.toLowerCase();
	}
	return null;
}

function themeFiles(rest: string): StorefrontThemeFile[] {
	const files = new Map<string, StorefrontThemeFile>();
	for (const m of rest.matchAll(THEME_FILE)) {
		const path = m[1] as string;
		if (!files.has(path)) {
			files.set(path, { path, checksum: m[2] ? m[2].toLowerCase() : null });
		}
	}
	return [...files.values()];
}

/** The storefront artifact a ref names, by the grammar above, or null where it names none. */
export function storefrontArtifactOf(ref: string): StorefrontArtifact | null {
	const text = ref.trim();
	const setting = SETTING.exec(text);
	if (setting) {
		return {
			kind: "setting",
			key: setting[1] as string,
			value: (setting[2] as string).replace(/^"|"$/g, ""),
		};
	}
	const subject = SUBJECT.exec(text);
	if (!subject) return null;
	const kind = (subject[1] as string).toLowerCase() as
		| "workflow"
		| "route"
		| "page"
		| "theme";
	const id = subject[2] as string;
	const rest = subject[3] ?? "";
	switch (kind) {
		case "workflow":
			return { kind, id, graph: firstHex(rest) };
		case "theme":
			return { kind, id, files: themeFiles(rest) };
		default:
			return { kind, id };
	}
}

/**
 * A landing that names no artifacts, read clause by clause (`;`-separated) by the same grammar: the
 * prose a mark wrote before artifacts existed. A clause naming none is returned as it is.
 */
export function storefrontLandingClauses(
	landing: string | null | undefined,
): Array<{ ref: string; artifact: StorefrontArtifact | null }> {
	return (landing ?? "")
		.split(";")
		.map((c) => c.trim())
		.filter((c) => c.length > 0)
		.map((ref) => ({ ref, artifact: storefrontArtifactOf(ref) }));
}
