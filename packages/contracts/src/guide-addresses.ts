// What an address on the public documentation (`/guides`) asks for, and the words for one that names
// nothing. Core answers a plain request for such an address with a 404 document before it serves
// the web; the web says the same words on a navigation inside it (docs/modules/guides/public-pages.md).

/** The two readers the documentation serves; the value is the `audience` a page declares. */
export const AUDIENCES = ["user", "agent"] as const;
export type Audience = (typeof AUDIENCES)[number];

export function isAudience(value: string): value is Audience {
	return (AUDIENCES as readonly string[]).includes(value);
}

/** The door each reader comes in by, in the reader's own words. */
export const DOOR_LABELS: Record<Audience, string> = {
	user: "I use Forge",
	agent: "I'm an agent or a script",
};

export const GUIDE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The slug a `/guides/<slug>` path names, decoded; empty when it names none. */
export function slugFromGuidePath(path: string | null | undefined): string {
	if (!path) return "";
	const rest = /^\/guides\/(.*)$/.exec(path.split("?")[0] ?? "")?.[1] ?? "";
	const bare = rest.replace(/\/+$/, "");
	try {
		return decodeURIComponent(bare);
	} catch {
		return bare;
	}
}

export const INDEX_HREF = "/guides";

export function missingGuideHeading(slug: string): string {
	return slug
		? `Forge publishes no guide called “${slug}”`
		: "Forge publishes no guide at that address";
}

/** Where every guide is readable as markdown: `guidesApiUrl` is core's `/api/guides` as the reader reaches it. */
export function missingGuideBody(guidesApiUrl: string): string {
	return `The index lists every guide there is, and each one is also readable as markdown at ${guidesApiUrl}/<slug>.md with no credential.`;
}

export const MISSING_GUIDE_LINK_TEXT = "All Forge guides";

/** A refusal of an address on the public documentation: what it says, twice. */
export interface Refusal {
	heading: string;
	body: string;
}

const PICK_FROM_INDEX =
	"The index lists every page behind each of its two doors.";

export function missingPage(slug: string): Refusal {
	return {
		heading: slug
			? `Forge publishes no page called “${slug}”`
			: "The link you followed names no page",
		body: PICK_FROM_INDEX,
	};
}

export function missingDoor(value: string): Refusal {
	return {
		heading: value
			? `The documentation has no door called “${value}”`
			: "The link you followed names no door",
		body: `A door is one of ${AUDIENCES.map((a) => `“${a}” (${DOOR_LABELS[a]})`).join(", ")}.`,
	};
}

export const PAGE_AND_DOOR: Refusal = {
	heading: "An address names a page or a door, not both",
	body: `Open the page on its own, or the door on its own. ${PICK_FROM_INDEX}`,
};

export type PublicRequest =
	| { kind: "landing" }
	| { kind: "door"; audience: Audience }
	| { kind: "page"; slug: string }
	| { kind: "refused"; refusal: Refusal };

/** What `/guides?path=…` or `?for=…` asks for; `helpSlugs` are the help pages the web carries. */
export function readPublicRequest(
	params: URLSearchParams,
	helpSlugs: readonly string[],
): PublicRequest {
	const path = params.get("path");
	const door = params.get("for");
	if (path !== null && door !== null)
		return { kind: "refused", refusal: PAGE_AND_DOOR };
	if (path !== null) {
		return helpSlugs.includes(path)
			? { kind: "page", slug: path }
			: { kind: "refused", refusal: missingPage(path) };
	}
	if (door !== null) {
		return isAudience(door)
			? { kind: "door", audience: door }
			: { kind: "refused", refusal: missingDoor(door) };
	}
	return { kind: "landing" };
}

const ESCAPES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
};

/** The slug comes off the URL, so it is caller-controlled. */
function escapeHtml(text: string): string {
	return text.replace(/[&<>"]/g, (c) => ESCAPES[c] ?? c);
}

/** A self-contained HTML 404 for an address naming nothing: styleless, rendered outside React. */
export function refusalDocument(
	{ heading, body }: Refusal,
	indexHref: string = INDEX_HREF,
): string {
	const h = escapeHtml(heading);
	return [
		"<!DOCTYPE html>",
		'<html lang="en"><head><meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		`<title>${h} — Forge guides</title>`,
		`<meta name="description" content="${escapeHtml(body)}">`,
		'<meta name="robots" content="noindex">',
		"</head><body>",
		`<h1>${h}</h1>`,
		`<p>${escapeHtml(body)}</p>`,
		`<p><a href="${escapeHtml(indexHref)}">${escapeHtml(MISSING_GUIDE_LINK_TEXT)}</a></p>`,
		"</body></html>",
		"",
	].join("\n");
}
