import { describe, expect, it } from "vitest";
import { refusalStatusOf } from "./refusal-statuses.js";
import {
	judgeHighlights,
	numeralsIn,
	RELEASE_CLIP_MAX_BYTES,
	RELEASE_PAGE_REFUSAL_CODES,
	type ReleaseHighlight,
	type ReleaseHighlightFacts,
	ReleaseHighlightSchema,
	ReleaseHighlightsSchema,
	type ReleaseMediaRef,
	ReleaseMediaRefSchema,
	ReleaseRangeReportSchema,
	ReleaseSeenSchema,
	ReleaseShownHighlightSchema,
	type ReleaseVerdictReading,
	releaseClaimOf,
	releaseEnded,
	releaseMediaKindOf,
	releasePagePath,
	whatsNewReleaseOwed,
} from "./release-page.js";

const BUILD = "a".repeat(40);
const MERGED = "b".repeat(40);
const v = (
	verdict: ReleaseVerdictReading["verdict"],
	commitSha: string | null,
	at: string,
	identityKind: string | null = "commit",
): ReleaseVerdictReading => ({ verdict, identityKind, commitSha, at });

describe("the truth rule: a page claims a criterion only with a pass on its build (BC-13)", () => {
	it("claims a pass on the build", () => {
		expect(
			releaseClaimOf([v("pass", BUILD, "2026-10-09T10:00:00Z")], BUILD),
		).toEqual({
			claimed: true,
			at: "2026-10-09T10:00:00Z",
		});
	});
	it("does not claim a pass on the merged commit, and says where it was judged", () => {
		expect(
			releaseClaimOf([v("pass", MERGED, "2026-10-09T10:00:00Z")], BUILD),
		).toEqual({
			claimed: false,
			standing: "not_judged",
			elsewhere: { verdict: "pass", commitSha: MERGED },
		});
	});
	it("reads a short on the build as a known issue, never a claim", () => {
		expect(
			releaseClaimOf([v("short", BUILD, "2026-10-09T10:00:00Z")], BUILD),
		).toMatchObject({
			claimed: false,
			standing: "short",
		});
	});
	it("takes the newest verdict on the build: a later fail outranks an earlier pass", () => {
		const claim = releaseClaimOf(
			[
				v("pass", BUILD, "2026-10-09T10:00:00Z"),
				v("fail", BUILD, "2026-10-09T11:00:00Z"),
			],
			BUILD,
		);
		expect(claim).toMatchObject({ claimed: false, standing: "fail" });
	});
	it("ignores a pass whose identity is not a commit, even naming the same sha", () => {
		expect(
			releaseClaimOf(
				[v("pass", BUILD, "2026-10-09T10:00:00Z", "runtime")],
				BUILD,
			).claimed,
		).toBe(false);
	});
	it("claims nothing before the release is verified, and reads no verdict as not judged", () => {
		expect(
			releaseClaimOf([v("pass", BUILD, "2026-10-09T10:00:00Z")], null).claimed,
		).toBe(false);
		expect(releaseClaimOf([], BUILD)).toEqual({
			claimed: false,
			standing: "not_judged",
			elsewhere: null,
		});
	});
});

const media = (over: Partial<ReleaseMediaRef> = {}): ReleaseMediaRef => ({
	kind: "clip",
	attachmentId: "00000000-0000-4000-8000-000000000001",
	name: "clip-iss-7-c2.webm",
	mime: "video/webm",
	bytes: 900_000,
	verdictId: "00000000-0000-4000-8000-000000000002",
	issueKey: "ISS-7",
	criterion: { n: 2, bc: "BC-2" },
	commitSha: MERGED,
	...over,
});

const facts: ReleaseHighlightFacts = {
	version: "0.4.0-dev.218",
	requirements: [
		{
			key: "REQ-40",
			title: "Every release is a readable page",
			text: "The page opens on 1-3 highlights. Each highlight shows a clip.",
			completes: false,
			claimable: ["BC-2", "BC-3"],
			media: [media()],
		},
		{
			key: "REQ-39",
			title: "Live preview",
			text: "A preview opens in 30 seconds.",
			completes: true,
			claimable: ["BC-1"],
			media: [],
		},
	],
};

const highlight = (over: Partial<ReleaseHighlight> = {}): ReleaseHighlight => ({
	requirement: { key: "REQ-40", title: "Every release is a readable page" },
	title: "Releases open on what changed",
	body: "Each release page now leads with up to 3 highlights, each with a clip QA recorded.",
	claims: ["BC-2"],
	media: media(),
	...over,
});

const codes = (h: ReleaseHighlight[], f = facts) =>
	judgeHighlights(h, f).map((r) => r.code);

describe("a release run's range report is refused unless whole", () => {
	const ok = { base: BUILD, head: MERGED, changes: [], files: [] };
	it("takes full commits, each changed path once named, and each file's two ends", () => {
		expect(ReleaseRangeReportSchema.safeParse(ok).success).toBe(true);
		expect(
			ReleaseRangeReportSchema.safeParse({
				...ok,
				changes: [{ path: "a.json", change: "added" }],
				files: [{ path: "a.json", base: null, head: "{}" }],
			}).success,
		).toBe(true);
	});
	it("refuses an abbreviated commit, an unknown change and a file missing an end", () => {
		expect(
			ReleaseRangeReportSchema.safeParse({ ...ok, base: "abc1234" }).success,
		).toBe(false);
		expect(
			ReleaseRangeReportSchema.safeParse({
				...ok,
				changes: [{ path: "a.json", change: "renamed" }],
			}).success,
		).toBe(false);
		expect(
			ReleaseRangeReportSchema.safeParse({
				...ok,
				files: [{ path: "a.json", head: "{}" }],
			}).success,
		).toBe(false);
	});
});

describe("drafted highlights are judged before they show (BC-2, BC-3, BC-13)", () => {
	it("passes a highlight drawn from the record, claiming a pass, showing its clip", () => {
		expect(judgeHighlights([highlight()], facts)).toEqual([]);
	});
	it("refuses a fourth highlight and an empty set where a requirement was advanced", () => {
		expect(codes([])).toEqual(["RELEASE_HIGHLIGHT_COUNT"]);
		const four = [1, 2, 3, 4].map(() => highlight());
		expect(codes(four)).toContain("RELEASE_HIGHLIGHT_COUNT");
	});
	it("takes no highlight where the release advances no requirement", () => {
		const none = { ...facts, requirements: [] };
		expect(codes([], none)).toEqual([]);
		expect(codes([highlight()], none)).toEqual([
			"RELEASE_HIGHLIGHT_COUNT",
			"RELEASE_HIGHLIGHT_REQUIREMENT_FOREIGN",
		]);
	});
	it("refuses a claim with no pass on the build, naming the code", () => {
		const r = judgeHighlights([highlight({ claims: ["BC-2", "BC-9"] })], facts);
		expect(r.map((x) => x.code)).toEqual(["RELEASE_HIGHLIGHT_UNCLAIMED"]);
		expect(r[0]?.detail).toContain("BC-9");
	});
	it("refuses a figure the requirement's record does not state", () => {
		const r = judgeHighlights(
			[highlight({ body: "Pages now load 40% faster with 3 highlights." })],
			facts,
		);
		expect(r.map((x) => x.code)).toEqual(["RELEASE_HIGHLIGHT_FIGURE_UNBACKED"]);
		expect(r[0]?.detail).toContain('"40"');
	});
	it("refuses a figure borrowed from another requirement's record", () => {
		expect(codes([highlight({ body: "It opens in 30 seconds." })])).toEqual([
			"RELEASE_HIGHLIGHT_FIGURE_UNBACKED",
		]);
	});
	it("refuses a requirement the release does not carry, and a second highlight on one", () => {
		expect(
			codes([highlight({ requirement: { key: "REQ-1", title: "x" } })]),
		).toContain("RELEASE_HIGHLIGHT_REQUIREMENT_FOREIGN");
		// one requirement here has a clip, so two highlights are one too many as well as a repeat
		expect(codes([highlight(), highlight()])).toEqual([
			"RELEASE_HIGHLIGHT_COUNT",
			"RELEASE_HIGHLIGHT_REPEATED",
		]);
	});
	it("refuses media that is not evidence of what the highlight claims", () => {
		const foreign = media({
			attachmentId: "00000000-0000-4000-8000-0000000000ff",
		});
		expect(codes([highlight({ media: foreign })])).toEqual([
			"RELEASE_HIGHLIGHT_MEDIA_FOREIGN",
		]);
	});
});

describe("every highlight shows a picture or clip from QA evidence (REQ-70 BC-2)", () => {
	const preview = highlight({
		requirement: { key: "REQ-39", title: "Live preview" },
		title: "Previews open quickly",
		body: "A preview opens as soon as you ask for it.",
		claims: ["BC-1"],
	});
	it("refuses a highlight of claims QA kept nothing of, naming the requirement that has a clip", () => {
		const r = judgeHighlights([preview], facts);
		expect(r.map((x) => x.code)).toEqual(["RELEASE_HIGHLIGHT_MEDIA_MISSING"]);
		expect(r[0]?.detail).toContain("REQ-39 BC-1");
		expect(r[0]?.detail).toContain("(REQ-40)");
		expect(r[0]?.detail).toContain("the QA agent records a clip");
		expect(codes([highlight({ claims: ["BC-3"] })])).toEqual([
			"RELEASE_HIGHLIGHT_MEDIA_MISSING",
		]);
	});
	it("never lets a requirement borrow a clip kept of another requirement's criterion of the same code", () => {
		const borrowed = media({ criterion: { n: 1, bc: "BC-1" } });
		const shared: ReleaseHighlightFacts = {
			...facts,
			requirements: facts.requirements.map((r) =>
				r.key === "REQ-40"
					? { ...r, claimable: ["BC-1", "BC-2"], media: [borrowed] }
					: r,
			),
		};
		expect(codes([{ ...preview, media: borrowed }], shared)).toEqual([
			"RELEASE_HIGHLIGHT_MEDIA_MISSING",
		]);
	});
	it("takes no more highlights than requirements QA kept a clip or picture of", () => {
		expect(codes([highlight(), preview])).toEqual([
			"RELEASE_HIGHLIGHT_COUNT",
			"RELEASE_HIGHLIGHT_MEDIA_MISSING",
		]);
	});
	it("refuses every draft, by one code, where QA kept no clip or picture of anything the release proves", () => {
		const bare: ReleaseHighlightFacts = {
			...facts,
			requirements: facts.requirements.map((r) => ({ ...r, media: [] })),
		};
		const r = judgeHighlights([highlight()], bare);
		expect(r.map((x) => x.code)).toEqual(["RELEASE_HIGHLIGHTS_NO_MEDIA"]);
		expect(r[0]?.detail).toContain("REQ-40 BC-2, BC-3; REQ-39 BC-1");
		expect(judgeHighlights([], bare).map((x) => x.code)).toEqual([
			"RELEASE_HIGHLIGHTS_NO_MEDIA",
		]);
	});
});

describe("a highlight's shape", () => {
	it("reads a highlight kept before REQ-70 BC-2, gap and all, where a release ended or a share froze it", () => {
		const kept = { ...highlight(), media: null, mediaGap: "no clip kept" };
		expect(ReleaseShownHighlightSchema.safeParse(kept).success).toBe(true);
		expect(ReleaseShownHighlightSchema.safeParse(highlight()).success).toBe(
			true,
		);
		expect(
			ReleaseShownHighlightSchema.safeParse({ ...kept, mediaGap: null })
				.success,
		).toBe(false);
		expect(
			["shipped", "failed", "aborted"].every((s) => releaseEnded(s as never)),
		).toBe(true);
		expect(
			["draft", "in_progress", "awaiting_approval", "returned"].some((s) =>
				releaseEnded(s as never),
			),
		).toBe(false);
	});
	it("always carries its media, and has no place to say why it has none", () => {
		expect(ReleaseHighlightSchema.safeParse(highlight()).success).toBe(true);
		expect(
			ReleaseHighlightSchema.safeParse({ ...highlight(), mediaGap: null })
				.success,
		).toBe(false);
		expect(
			ReleaseHighlightSchema.safeParse({
				...highlight(),
				media: null,
				mediaGap: "no clip kept",
			}).success,
		).toBe(false);
	});
	it("refuses a body past forty words and a highlight claiming nothing", () => {
		const long = Array.from({ length: 41 }, () => "word").join(" ");
		expect(
			ReleaseHighlightSchema.safeParse(highlight({ body: long })).success,
		).toBe(false);
		expect(
			ReleaseHighlightSchema.safeParse(highlight({ claims: [] })).success,
		).toBe(false);
	});
	it("stores at most three drafted highlights, and a release with none says why", () => {
		const drafted = {
			state: "drafted",
			model: "gateway/fast",
			draftedAt: "2026-10-09T10:00:00Z",
			sourceDigest: "d1",
		};
		expect(
			ReleaseHighlightsSchema.safeParse({
				...drafted,
				highlights: [highlight()],
			}).success,
		).toBe(true);
		expect(
			ReleaseHighlightsSchema.safeParse({
				...drafted,
				highlights: [1, 2, 3, 4].map(() => highlight()),
			}).success,
		).toBe(false);
		expect(ReleaseHighlightsSchema.safeParse({ state: "none" }).success).toBe(
			false,
		);
	});
});

describe("release media", () => {
	it("reads clips and pictures by type and nothing else", () => {
		expect(releaseMediaKindOf("video/webm")).toBe("clip");
		expect(releaseMediaKindOf("image/png")).toBe("picture");
		expect(releaseMediaKindOf("text/plain")).toBeNull();
		expect(releaseMediaKindOf("video/quicktime")).toBeNull();
	});
	it("refuses a clip over the upload ceiling and an abbreviated commit", () => {
		expect(
			ReleaseMediaRefSchema.safeParse(
				media({ bytes: RELEASE_CLIP_MAX_BYTES + 1 }),
			).success,
		).toBe(false);
		expect(
			ReleaseMediaRefSchema.safeParse(media({ commitSha: "abc1234" })).success,
		).toBe(false);
	});
});

describe("What's new opens once per person per environment (BC-10)", () => {
	const seen = {
		environment: "forge-dev",
		version: "0.4.0-dev.96",
		at: "2026-10-09T10:00:00Z",
	};
	it("opens for a newer release, and for a person who never saw one", () => {
		expect(
			whatsNewReleaseOwed(seen, {
				environment: "forge-dev",
				version: "0.4.0-dev.100",
			}),
		).toBe(true);
		expect(
			whatsNewReleaseOwed(null, {
				environment: "forge-dev",
				version: "0.4.0-dev.1",
			}),
		).toBe(true);
	});
	it("does not open again for the same release, nor on a rollback", () => {
		expect(
			whatsNewReleaseOwed(seen, {
				environment: "forge-dev",
				version: "0.4.0-dev.96",
			}),
		).toBe(false);
		expect(
			whatsNewReleaseOwed(seen, {
				environment: "forge-dev",
				version: "0.4.0-dev.9",
			}),
		).toBe(false);
	});
	it("counts another environment on its own, and opens nothing where no release serves", () => {
		expect(
			whatsNewReleaseOwed(seen, {
				environment: "forge-beta",
				version: "0.4.0-dev.96",
			}),
		).toBe(true);
		expect(whatsNewReleaseOwed(seen, null)).toBe(false);
	});
	it("refuses a seen mark with no environment", () => {
		expect(
			ReleaseSeenSchema.safeParse({ ...seen, environment: " " }).success,
		).toBe(false);
	});
});

describe("release page refusals", () => {
	it("answer the statuses their remedy needs", () => {
		expect(refusalStatusOf("RELEASE_PAGE_NOT_FOUND")).toBe(404);
		expect(refusalStatusOf("RELEASE_HIGHLIGHTS_MODEL_UNCONFIGURED")).toBe(503);
		expect(refusalStatusOf("RELEASE_HIGHLIGHT_UNCLAIMED")).toBe(422);
		expect(new Set(RELEASE_PAGE_REFUSAL_CODES).size).toBe(
			RELEASE_PAGE_REFUSAL_CODES.length,
		);
	});
	it("reads figures as written", () => {
		expect(numeralsIn("1-3 highlights in 0.4.0-dev.96, 40%")).toEqual([
			"1",
			"3",
			"0.4.0",
			"96",
			"40",
		]);
	});
	it("reads a page at one path per version and view, the version escaped", () => {
		expect(releasePagePath("p1", "0.4.0-dev.96", "developer")).toBe(
			"/api/projects/p1/releases/0.4.0-dev.96/page?view=developer",
		);
		expect(releasePagePath("p1", "a/b", "user")).toContain(
			"/releases/a%2Fb/page",
		);
	});
});
