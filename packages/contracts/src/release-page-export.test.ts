import { describe, expect, it } from "vitest";
import type { ReleasePage } from "./release-page.js";
import {
	releasePageEmail,
	releasePageEml,
	releasePageMarkdown,
} from "./release-page-export.js";

const BUILD = "a".repeat(40);

function page(over: Partial<ReleasePage> = {}): ReleasePage {
	return {
		view: "user",
		projectId: "p1",
		header: {
			version: "0.4.0",
			state: "shipped",
			releasedAt: "2026-10-09T10:00:00.000Z",
			environment: { name: "production", url: "https://forge.example" },
			build: BUILD,
			verified: {
				level: "criteria",
				proven: 2,
				total: 3,
				check: null,
				provider: null,
			},
			approval: {
				required: true,
				state: "approved",
				by: { id: "u1", name: "Ada", kind: "human" },
				at: "2026-10-09T09:00:00.000Z",
			},
		},
		highlights: {
			state: "drafted",
			model: "m",
			draftedAt: "2026-10-09T10:00:00.000Z",
			sourceDigest: "d",
			highlights: [
				{
					requirement: { key: "REQ-40", title: "Release page" },
					title: "Every release has a page",
					body: "Open a release and read what changed.",
					claims: ["BC-1"],
					media: {
						kind: "clip",
						attachmentId: "00000000-0000-4000-8000-000000000001",
						name: "page.webm",
						mime: "video/webm",
						bytes: 10,
						verdictId: "00000000-0000-4000-8000-000000000002",
						issueKey: "ISS-1",
						criterion: { n: 1, bc: "BC-1" },
						commitSha: BUILD,
						url: "/api/attachments/x/download",
					},
					mediaGap: null,
				},
			],
		},
		requirements: [
			{
				key: "REQ-40",
				title: "Release page",
				completes: true,
				proven: [{ code: "BC-1", statement: "Each release has a page." }],
				unproven: 1,
			},
		],
		improvements: [
			{ issueKey: "ISS-1", kind: "new", line: "Releases read as pages." },
		],
		fixes: [
			{ issueKey: "ISS-2", kind: "fixed", line: "Dates show correctly." },
		],
		withoutNotes: [],
		actionRequired: [],
		knownIssues: [
			{
				issueKey: "ISS-3",
				requirementKey: "REQ-40",
				bc: "BC-8",
				statement: "Known issues are listed.",
				standing: "short",
				reason: "the list is empty on mobile",
				elsewhere: null,
			},
		],
		technical: null,
		can: { share: true, export: true, approve: false },
		...over,
	};
}

describe("a release page as Markdown (BC-11)", () => {
	const md = releasePageMarkdown(page(), { origin: "https://forge.example" });
	it("heads with the version and the header facts", () => {
		expect(md).toContain("# Release 0.4.0");
		expect(md).toContain(
			"Released 2026-10-09 · Runs at https://forge.example · Build aaaaaaa",
		);
		expect(md).toContain(
			"2 of 3 criteria proven · Approved by Ada on 2026-10-09",
		);
	});
	it("writes each user section, with the clip as an absolute link", () => {
		expect(md).toContain(
			"## Highlights\n- Every release has a page: Open a release and read what changed. ([Watch the clip](https://forge.example/api/attachments/x/download))",
		);
		expect(md).toContain("## Improvements\n- Releases read as pages.");
		expect(md).toContain("## Fixes\n- Dates show correctly.");
		expect(md).toContain(
			"- Release page (complete): Each release has a page. (1 not yet proven on this build)",
		);
		expect(md).toContain(
			"- Known issues are listed. (falls short: the list is empty on mobile)",
		);
	});
	it("says an empty Action required reads empty, and never names an issue key", () => {
		expect(md).toContain("## Action required\nNothing is required of you.");
		expect(md).not.toContain("ISS-");
	});
	it("never carries the technical notes of a developer-view page", () => {
		const dev = page({
			view: "developer",
			technical: {
				notes: [
					{ issueKey: "ISS-1", title: "t", technical: "SECRET-TECHNICAL-NOTE" },
				],
				migrations: ["0478_release_highlights.sql"],
				contracts: [],
				dependencies: [],
				changes: {
					surfaces: [],
					risks: [],
					unclassified: [],
					boxRead: [],
					shipsNothing: false,
				},
			} as unknown as ReleasePage["technical"],
		});
		const out = releasePageMarkdown(dev);
		const mail = releasePageEmail(dev);
		for (const s of [out, mail.text, mail.html]) {
			expect(s).not.toContain("SECRET-TECHNICAL-NOTE");
			expect(s).not.toContain("0478_release");
		}
	});
	it("omits the highlights of a page whose draft is not stored, and reads the rest", () => {
		const out = releasePageMarkdown(
			page({
				highlights: { state: "pending", since: "2026-10-09T10:00:00.000Z" },
			}),
		);
		expect(out).not.toContain("## Highlights");
		expect(out).toContain("## Improvements");
	});
});

describe("a release page as an email (BC-11)", () => {
	it("has a subject, a plain-text body and an escaped HTML body from the same sections", () => {
		const e = releasePageEmail(
			page({
				fixes: [
					{
						issueKey: "ISS-2",
						kind: "fixed",
						line: "<script>x</script> & more",
					},
				],
			}),
		);
		expect(e.subject).toBe("Release 0.4.0");
		expect(e.text).toContain("HIGHLIGHTS\n- Every release has a page");
		expect(e.text).toContain("<script>x</script> & more");
		expect(e.html).toContain("&lt;script&gt;x&lt;/script&gt; &amp; more");
		expect(e.html).not.toContain("<script>");
	});
	it("assembles an .eml: an RFC 2047 subject and two base64 alternatives that decode back", () => {
		const e = releasePageEmail(
			page({
				fixes: [
					{ issueKey: "ISS-2", kind: "fixed", line: "Sửa lỗi ngày — ok" },
				],
			}),
		);
		const eml = releasePageEml(e, new Date("2026-10-09T10:00:00.000Z"));
		expect(eml).toContain("Date: Fri, 09 Oct 2026 10:00:00 GMT");
		expect(eml).toContain("X-Unsent: 1");
		const subject = /Subject: =\?UTF-8\?B\?(.+?)\?=/.exec(eml)?.[1] ?? "";
		expect(atob(subject)).toBe("Release 0.4.0");
		const bodies = eml.split(/--forge-release-\w+\r\n/).slice(1);
		expect(bodies).toHaveLength(2);
		const decode = (part: string) => {
			const b64 =
				part.split("\r\n\r\n")[1]?.split("\r\n--")[0]?.replace(/\r\n/g, "") ??
				"";
			return new TextDecoder().decode(
				Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
			);
		};
		expect(decode(bodies[0] ?? "")).toBe(e.text);
		expect(decode(bodies[1] ?? "")).toBe(e.html);
		expect(decode(bodies[0] ?? "")).toContain("Sửa lỗi ngày — ok");
		for (const line of eml.split("\r\n"))
			expect(line.length).toBeLessThanOrEqual(998);
	});
});
