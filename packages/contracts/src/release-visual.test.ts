// ISS-1308: the card a master's release post carries orders only what judges marked: a clip's still
// as its cover, the shots after it, never more than a room message holds, and never a picture over
// the room's size, which the post would be refused for.
import { describe, expect, it } from "vitest";
import type { ReleaseLineVisual, ReleaseVisualFile } from "./release-page.js";
import { releaseCardOf } from "./release-visual.js";
import { ROOM_IMAGE_CAPS } from "./support.js";

let seq = 0;
const file = (kind: "clip" | "picture", bytes = 10): ReleaseVisualFile => {
	seq += 1;
	const attachmentId = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
	return kind === "clip"
		? { attachmentId, name: `c${seq}.webm`, kind, mime: "video/webm", bytes }
		: { attachmentId, name: `p${seq}.png`, kind, mime: "image/png", bytes };
};
const visual = (v: Partial<ReleaseLineVisual>): ReleaseLineVisual => ({
	desktop: null,
	phone: null,
	still: null,
	seconds: null,
	verdictId: "00000000-0000-4000-8000-0000000000ff",
	criterion: 1,
	...v,
});
const line = (issueKey: string, v: ReleaseLineVisual | null) => ({ issueKey, line: issueKey, visual: v });
const header = { verified: { proven: 3, total: 4 } } as Parameters<typeof releaseCardOf>[0]["header"];

describe("the release card (ISS-1308)", () => {
	it("covers with the first clip's still, then carries at most three more shots", () => {
		const clip = visual({ desktop: file("clip"), still: file("picture"), phone: file("picture"), seconds: 20 });
		const shots = [visual({ desktop: file("picture") }), visual({ desktop: file("picture"), phone: file("picture") })];
		const card = releaseCardOf(
			{ header, improvements: [line("A", clip)], fixes: [line("B", shots[0] ?? null), line("C", shots[1] ?? null), line("D", null)] },
			"https://forge.test/projects/forge/releases/1.0.0",
		);
		expect(card.cover).toEqual({ attachmentId: clip.still?.attachmentId, issueKey: "A", clip: true, seconds: 20 });
		expect(card.shots.map((s) => s.issueKey)).toEqual(["A", "B", "C"]);
		expect(card.attachments).toHaveLength(ROOM_IMAGE_CAPS.perMessage);
		expect(card.lines.map((l) => l.issueKey)).toEqual(["A", "B", "C"]);
		expect(card.criteria).toEqual({ proven: 3, total: 4 });
	});

	it("posts no picture over the room's size and no clip, so a clip with no still is no cover", () => {
		const card = releaseCardOf(
			{
				header,
				improvements: [line("A", visual({ desktop: file("clip") })), line("B", visual({ desktop: file("picture", ROOM_IMAGE_CAPS.bytes + 1) }))],
				fixes: [],
			},
			"l",
		);
		expect(card.cover).toBeNull();
		expect(card.attachments).toEqual([]);
	});
});
