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
			name: "Readable releases",
			summary: "Every release now opens as a page you can read in a minute. Each change is named in a short title and one sentence.",
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
				proven: [
					{
						code: "BC-1",
						statement: "The page shows the version and date.",
						short: false,
						issueKey: "ISS-1",
						n: 1,
						countedUnderCutover: false,
					},
					{
						code: "BC-1",
						statement: "The page names who approved it.",
						short: false,
						issueKey: "ISS-1",
						n: 2,
						countedUnderCutover: false,
					},
					{
						code: "BC-2",
						statement: "Highlights open it.",
						short: true,
						issueKey: "ISS-1",
						n: 3,
						countedUnderCutover: false,
					},
				],
				unproven: 1,
				business: {
					total: 13,
					proven: [
						{ code: "BC-1", statement: "Each release has a page." },
						{ code: "BC-2", statement: "The page opens on highlights." },
					],
				},
			},
		],
		untraced: {
			proven: [
				{
					code: null,
					statement: "The export opens in a mail client.",
					short: false,
					issueKey: "ISS-4",
					n: 1,
					countedUnderCutover: false,
				},
			],
			unproven: 0,
		},
		improvements: [
			{
				issueKey: "ISS-1",
				kind: "new",
				section: "Added",
				line: "Releases read as pages",
				detail: "Open any release and read what it brings, whole.",
				requirementKey: "REQ-40",
			},
		],
		fixes: [
			{
				issueKey: "ISS-2",
				kind: "fixed",
				section: "Fixed",
				line: "Dates show correctly.",
				detail: null,
				requirementKey: null,
			},
		],
		internal: { count: 2, changes: null },
		withoutNotes: [],
		actionRequired: [],
		shipped: {
			state: "read",
			base: "b".repeat(40),
			head: BUILD,
			migrations: [],
			contracts: [],
			dependencies: [],
			settings: [],
		},
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

const fix = (line: string) => ({
	issueKey: "ISS-2",
	kind: "fixed" as const,
	section: "Fixed" as const,
	line,
	detail: null,
	requirementKey: null,
});

describe("a release page as Markdown (BC-11), shaped as its overview (REQ-40)", () => {
	const md = releasePageMarkdown(page(), { origin: "https://forge.example" });
	it("heads with the version and name, the summary it was cut with, and the header facts", () => {
		expect(md).toContain(
			"# 0.4.0 · Readable releases\n\nEvery release now opens as a page you can read in a minute.",
		);
		expect(md).toContain(
			"Released 2026-10-09 · Runs at https://forge.example · Build aaaaaaa",
		);
		expect(md).toContain("2 of 3 checks met · Approved by Ada on 2026-10-09");
	});
	it("heads a release cut without a name by its version alone", () => {
		const bare = page();
		const out = releasePageMarkdown(
			page({ header: { ...bare.header, name: null, summary: null } }),
		);
		expect(out.startsWith("# Release 0.4.0\n\nReleased")).toBe(true);
	});
	it("writes each change in its group as its title and its sentence, whole, with the clip as an absolute link", () => {
		expect(md).toContain(
			"## Highlights\n- Every release has a page: Open a release and read what changed. ([Watch the clip](https://forge.example/api/attachments/x/download))",
		);
		expect(md).toContain(
			"## New\n- Releases read as pages: Open any release and read what it brings, whole.",
		);
		expect(md).toContain("## Fixed\n- Dates show correctly.");
	});
	it("counts the requirements' checks and the changes users do not see, and lists no criterion (BC-15, BC-16)", () => {
		expect(md).toContain(
			"## Requirements\n- Release page (complete): 2 checks met by this release",
		);
		expect(md).toContain(
			"## Internal\n- 2 changes nobody using the product sees.",
		);
		expect(md).toContain(
			"## Known issues\n- 1 check is not yet met on this build.",
		);
		for (const criterion of [
			"The page shows the version and date.",
			"Each release has a page.",
			"The export opens in a mail client.",
			"Known issues are listed.",
		])
			expect(md).not.toContain(criterion);
	});
	it("says what an admin must do before it goes out, and never the file behind a step", () => {
		const ref = "packages/core/drizzle/migrations/0495_intake_retry.sql";
		const asks = releasePageMarkdown(
			page({
				header: { ...page().header, state: "awaiting_approval" },
				actionRequired: [
					{ kind: "step", ref: null, issues: ["ISS-1"], sentence: "Start a worker on the deploy queue." },
					{ kind: "migration", ref, issues: ["ISS-455"], sentence: "Back up the database before this release deploys: it changes the schema." },
				],
			}),
		);
		expect(asks).toContain(
			"## Before you release\n- Start a worker on the deploy queue.\n- Back up the database",
		);
		expect(asks).not.toContain(ref);
	});
	it("says an empty Action required reads empty, and never names an issue key", () => {
		expect(md).toContain("## Action required\nNothing is required of you.");
		expect(md).not.toContain("ISS-");
	});
	it("does not say nothing is required where no step was written and the range was not read", () => {
		const out = releasePageMarkdown(
			page({
				shipped: { state: "unread", why: "the repository was unreachable" },
			}),
		);
		expect(out).not.toContain("Nothing is required of you.");
		expect(out).toContain(
			"No admin step was written, and the commit range was not read.",
		);
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
				settings: [],
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
		expect(out).toContain("## New");
	});
});

describe("a release page as an email (BC-11)", () => {
	it("has a subject, a plain-text body and an escaped HTML body from the same sections", () => {
		const e = releasePageEmail(
			page({ fixes: [fix("<script>x</script> & more")] }),
		);
		expect(e.subject).toBe("0.4.0 · Readable releases");
		expect(e.text).toContain("Every release now opens as a page");
		expect(e.text).toContain("HIGHLIGHTS\n- Every release has a page");
		expect(e.text).toContain("<script>x</script> & more");
		expect(e.html).toContain("&lt;script&gt;x&lt;/script&gt; &amp; more");
		expect(e.html).not.toContain("<script>");
	});
	it("assembles an .eml: an RFC 2047 subject and two base64 alternatives that decode back", () => {
		const e = releasePageEmail(page({ fixes: [fix("Sửa lỗi ngày — ok")] }));
		const eml = releasePageEml(e, new Date("2026-10-09T10:00:00.000Z"));
		expect(eml).toContain("Date: Fri, 09 Oct 2026 10:00:00 GMT");
		expect(eml).toContain("X-Unsent: 1");
		const utf8 = (b64: string) =>
			new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
		const subject = /Subject: =\?UTF-8\?B\?(.+?)\?=/.exec(eml)?.[1] ?? "";
		expect(utf8(subject)).toBe("0.4.0 · Readable releases");
		const bodies = eml.split(/--forge-release-\w+\r\n/).slice(1);
		expect(bodies).toHaveLength(2);
		const decode = (part: string) =>
			utf8(
				part.split("\r\n\r\n")[1]?.split("\r\n--")[0]?.replace(/\r\n/g, "") ??
					"",
			);
		expect(decode(bodies[0] ?? "")).toBe(e.text);
		expect(decode(bodies[1] ?? "")).toBe(e.html);
		expect(decode(bodies[0] ?? "")).toContain("Sửa lỗi ngày — ok");
		for (const line of eml.split("\r\n"))
			expect(line.length).toBeLessThanOrEqual(998);
	});
});
