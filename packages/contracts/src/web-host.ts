// What a web build tells the core that serves it (packages/core/src/web-host): the routes the
// single-page app answers and the help pages it carries. The build writes it beside index.html;
// core reads it once, so a path no route names is answered 404 rather than an empty 200.

/** The manifest's file name in the web build's output directory. */
export const WEB_HOST_MANIFEST = "web-host.json";

export interface WebHostManifest {
	/** The path the build was made to be served under (`''` at the root): its asset URLs carry it. */
	basePath: string;
	/** Every route's full path as the router declares it: `$name` is one segment, a lone `$` the rest. */
	routes: string[];
	/** The slugs of the help pages the web carries (`/guides?path=<slug>`). */
	helpSlugs: string[];
}

const isStringList = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((v) => typeof v === "string");

/** The manifest, or why the value is not one: the field that is wrong. */
export function readWebHostManifest(
	value: unknown,
): WebHostManifest | { refused: string } {
	if (typeof value !== "object" || value === null)
		return { refused: "it is not a JSON object" };
	const { basePath, routes, helpSlugs } = value as Record<string, unknown>;
	if (typeof basePath !== "string")
		return { refused: "`basePath` is not a path" };
	if (!isStringList(routes) || routes.length === 0) {
		return { refused: "`routes` is not a non-empty list of paths" };
	}
	if (!isStringList(helpSlugs))
		return { refused: "`helpSlugs` is not a list of slugs" };
	return { basePath, routes, helpSlugs };
}

const segments = (path: string): string[] =>
	path.split("/").filter((s) => s.length > 0);

/** Whether `path` (no base path, no query) is one `pattern` names. */
export function matchesRoute(pattern: string, path: string): boolean {
	const want = segments(pattern);
	const have = segments(path);
	for (const [i, part] of want.entries()) {
		if (part === "$") return have.length > i;
		const seg = have[i];
		if (seg === undefined) return false;
		if (part.startsWith("$")) continue;
		if (part !== seg) return false;
	}
	return have.length === want.length;
}
