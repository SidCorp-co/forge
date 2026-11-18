// What a release shows of each line (ISS-1308): the clip or shots its judge marked on a verdict, the
// lines that touched a screen and show none (counted for the developer view, never refused), and the
// card a master's release post carries into the project's thread. Core picks no file: every file here
// is one a judge marked (`POST /api/issues/:id/verdicts`, `releaseVisual`), and the card only orders
// them; the post's words are the master's, in the owner's language (agent-is-the-voice).

import type {
	ReleaseLineVisual,
	ReleasePage,
	ReleasePageChange,
	ReleaseVisualFile,
} from "./release-page.js";
import { ROOM_IMAGE_CAPS } from "./support.js";

/** The longest clip length a mark may state, in whole seconds. */
export const RELEASE_VISUAL_SECONDS_MAX = 3600;

/** What a verdict's `releaseVisual` is, as its refusals say it. */
export const RELEASE_VISUAL_MARK_SHAPE =
	"`releaseVisual: { desktop?, phone?, still?, seconds? }` on a `pass`: `desktop` (shown at 16:10) and `phone` (shown at 9:19.5) each name one of this issue's attachments, a WebM or MP4 clip or a PNG, JPEG, WebP or GIF picture of at most 10 MiB, by its id or its download URL (`/api/attachments/:id/download`), at least one of the two; `still` names the picture a clip opens on; `seconds` is the clip's length in whole seconds";

/** One line that touched a screen (`ui` surfaces) and shows nothing its judge marked. */
export interface ReleaseVisualOwed {
	issueKey: string;
	line: string;
	kind: "new" | "fixed";
}

/**
 * The developer view's owed visuals: each New or Fixed line whose landing touched `ui` surfaces,
 * with no visual marked and no `withoutClip` saying why none. Shown and counted, never a gate.
 */
export interface ReleaseVisualsOwed {
	count: number;
	lines: ReleaseVisualOwed[];
}

/** The lines a card leads with, and the most shots it carries beside its cover. */
export const RELEASE_CARD_LINES = 3;
export const RELEASE_CARD_SHOTS = ROOM_IMAGE_CAPS.perMessage - 1;

/** A picture the card posts: an attachment of `issueKey`'s issue the master names in `attachments`. */
export interface ReleaseCardPicture {
	attachmentId: string;
	issueKey: string;
}

/**
 * What a master's release post carries (ISS-1308): a cover (a clip's still, or a shot), the three
 * leading lines, the criteria count, up to three more shots and one link to the page. `attachments`
 * is the post's `attachments` as `support/master-posts` takes it, cover first; the words are the
 * master's own.
 */
export interface ReleaseCard {
	/** The cover picture; `seconds` is the length of the clip it is the still of, null for a shot. */
	cover: (ReleaseCardPicture & { clip: boolean; seconds: number | null }) | null;
	lines: { issueKey: string; line: string; kind: "new" | "fixed" }[];
	criteria: { proven: number; total: number };
	shots: ReleaseCardPicture[];
	link: string;
	attachments: { target: "issue"; attachmentId: string }[];
}

type CardLine = Pick<ReleasePageChange, "issueKey" | "line" | "visual">;

/** Whether a room takes the file as a picture: a picture within the room's size. */
const postable = (f: ReleaseVisualFile | null): f is ReleaseVisualFile =>
	f !== null && f.kind === "picture" && f.bytes <= ROOM_IMAGE_CAPS.bytes;

/** The cover a line's visual offers: the still of its clip first, else its desktop shot, else its phone shot. */
function coverOf(
	v: ReleaseLineVisual,
): { file: ReleaseVisualFile; clip: boolean } | null {
	const clip = [v.desktop, v.phone].some((f) => f?.kind === "clip");
	if (clip && postable(v.still)) return { file: v.still, clip: true };
	const shot = [v.desktop, v.phone].find(postable);
	return shot ? { file: shot, clip: false } : null;
}

/** Every picture a line's visual can post, in the order a reader meets them. */
const picturesOf = (v: ReleaseLineVisual): ReleaseVisualFile[] =>
	[v.still, v.desktop, v.phone].filter(postable);

/**
 * The card of a release (ISS-1308): its New lines then its Fixed lines, in the page's order. The
 * cover is the first line's that has a postable picture, the shots the pictures after it, each once.
 * Nothing is chosen by a file's name: every picture is one a judge marked.
 */
export function releaseCardOf(
	page: Pick<ReleasePage, "header"> & {
		improvements: readonly CardLine[];
		fixes: readonly CardLine[];
	},
	link: string,
): ReleaseCard {
	const ordered = [
		...page.improvements.map((c) => ({ c, kind: "new" as const })),
		...page.fixes.map((c) => ({ c, kind: "fixed" as const })),
	];
	let cover: ReleaseCard["cover"] = null;
	for (const { c } of ordered) {
		const found = c.visual ? coverOf(c.visual) : null;
		if (!found || !c.visual) continue;
		cover = {
			attachmentId: found.file.attachmentId,
			issueKey: c.issueKey,
			clip: found.clip,
			seconds: found.clip ? c.visual.seconds : null,
		};
		break;
	}
	const seen = new Set(cover ? [cover.attachmentId] : []);
	const shots: ReleaseCardPicture[] = [];
	for (const { c } of ordered) {
		for (const f of c.visual ? picturesOf(c.visual) : []) {
			if (shots.length >= RELEASE_CARD_SHOTS || seen.has(f.attachmentId)) continue;
			seen.add(f.attachmentId);
			shots.push({ attachmentId: f.attachmentId, issueKey: c.issueKey });
		}
	}
	return {
		cover,
		lines: ordered
			.slice(0, RELEASE_CARD_LINES)
			.map(({ c, kind }) => ({ issueKey: c.issueKey, line: c.line, kind })),
		criteria: {
			proven: page.header.verified.proven,
			total: page.header.verified.total,
		},
		shots,
		link,
		attachments: [...(cover ? [cover] : []), ...shots].map((p) => ({
			target: "issue" as const,
			attachmentId: p.attachmentId,
		})),
	};
}

/** What a release shows, counted for its hero: the clips and the shots its lines' judges marked. */
export function releaseVisualCounts(
	lines: readonly Pick<ReleasePageChange, "visual">[],
): { clips: number; shots: number } {
	let clips = 0;
	let shots = 0;
	for (const { visual } of lines) {
		for (const f of visual ? [visual.desktop, visual.phone] : []) {
			if (f?.kind === "clip") clips += 1;
			else if (f) shots += 1;
		}
	}
	return { clips, shots };
}
