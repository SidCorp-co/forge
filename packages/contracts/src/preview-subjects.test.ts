import { describe, expect, it } from "vitest";
import {
	confirmFixRequestSchema,
	keepPreviewRequestSchema,
	keptPreviewContentSchema,
	openPreviewRequestSchema,
	PREVIEW_REFUSAL_CODES,
	PREVIEW_ROUTES,
	previewDemoSettingsSchema,
	previewRecordSchema,
	previewSettingsSchema,
	previewSubjectSchema,
	reproduceDataOf,
} from "./preview.js";

const SHA = "0d91ae7c74f70295ede115463b17559e650b5207";
const UUID = "8df98619-9f7c-46b8-8e65-a67f2fcdce74";

describe("a preview no issue's run holds (REQ-41)", () => {
	it("serves an idea on a sketch branch, never a branch that can be pushed as work", () => {
		const idea = {
			kind: "idea",
			about: { kind: "feedback", key: "FB-51" },
			branch: "sketch/fb-51-abcdef",
		};
		expect(previewSubjectSchema.safeParse(idea).success).toBe(true);
		expect(
			previewSubjectSchema.safeParse({ ...idea, branch: "main" }).success,
		).toBe(false);
		expect(
			previewSubjectSchema.safeParse({
				...idea,
				branch: "sketch/iss-51-abcdef",
			}).success,
		).toBe(false);
	});

	it("reproduces a past build by its whole sha", () => {
		const r = previewSubjectSchema.safeParse({
			kind: "reproduce",
			feedback: "FB-52",
			build: { sha: SHA, release: "0.4.0-dev.217" },
			record: true,
		});
		expect(r.success).toBe(true);
		const short = previewSubjectSchema.safeParse({
			kind: "reproduce",
			feedback: "FB-52",
			build: { sha: "0d91ae7", release: null },
			record: true,
		});
		expect(short.success).toBe(false);
	});

	it("still names an issue's run as REQ-39 does", () => {
		expect(
			previewSubjectSchema.safeParse({ kind: "issue", issueId: UUID }).success,
		).toBe(true);
	});
});

describe("opening one from chat or a feedback item", () => {
	it("opens an idea about a requirement or feedback from what was asked", () => {
		expect(
			openPreviewRequestSchema.safeParse({
				kind: "idea",
				about: "REQ-35",
				brief: "Show the picture first",
			}).success,
		).toBe(true);
		expect(
			openPreviewRequestSchema.safeParse({
				kind: "idea",
				about: "ISS-35",
				brief: "x",
			}).success,
		).toBe(false);
		expect(
			openPreviewRequestSchema.safeParse({
				kind: "idea",
				about: "FB-51",
				brief: "  ",
			}).success,
		).toBe(false);
	});

	it("records a reproduce by default, and takes a release or a sha but not both", () => {
		const r = openPreviewRequestSchema.parse({
			kind: "reproduce",
			feedback: "FB-52",
		});
		expect(r).toEqual({ kind: "reproduce", feedback: "FB-52", record: true });
		expect(
			openPreviewRequestSchema.safeParse({
				kind: "reproduce",
				feedback: "FB-52",
				build: { release: "0.4.0-dev.217", sha: SHA },
			}).success,
		).toBe(false);
	});
});

describe("keeping an idea as the requirement's picture (BC-16)", () => {
	const snapshot = [
		{
			type: 4,
			timestamp: 1,
			data: { href: "https://x.invalid/", width: 800, height: 600 },
		},
		{
			type: 2,
			timestamp: 2,
			data: { node: {}, initialOffset: { top: 0, left: 0 } },
		},
	];
	const kept = {
		previewId: UUID,
		branch: "sketch/req-41-abcdef",
		head: SHA,
		base: SHA,
		patchId: SHA,
		files: ["packages/web-v2/src/app/page.tsx"],
		asked: ["Make the chat box larger"],
		snapshot,
	};

	it("holds the branch head, the patch id, what was asked and the page's one snapshot", () => {
		expect(keptPreviewContentSchema.safeParse(kept).success).toBe(true);
	});

	it("refuses a kept preview with no snapshot or one that is not Meta then FullSnapshot: a picture shows something", () => {
		expect(
			keptPreviewContentSchema.safeParse({ ...kept, snapshot: [] }).success,
		).toBe(false);
		expect(
			keptPreviewContentSchema.safeParse({
				...kept,
				snapshot: [...snapshot].reverse(),
			}).success,
		).toBe(false);
		expect(
			keepPreviewRequestSchema.safeParse({
				alt: "The home",
				snapshot: snapshot.slice(0, 1),
			}).success,
		).toBe(false);
	});

	it("refuses a head that is not a whole sha, and a branch that could be pushed as work", () => {
		expect(
			keptPreviewContentSchema.safeParse({ ...kept, head: "abc123" }).success,
		).toBe(false);
		expect(
			keptPreviewContentSchema.safeParse({ ...kept, branch: "main" }).success,
		).toBe(false);
	});

	it("names its route and its refusal in the registry", () => {
		expect(PREVIEW_ROUTES.keep).toBe("/api/previews/:id/keep");
		expect(PREVIEW_REFUSAL_CODES as readonly string[]).toContain(
			"PREVIEW_KEEP_NOT_IDEA",
		);
		expect(PREVIEW_REFUSAL_CODES as readonly string[]).toContain(
			"PREVIEW_KEEP_SNAPSHOT_INVALID",
		);
	});
});

describe("where a reproduce gets its data (BC-22)", () => {
	it("uses demo data where the preview setting names it", () => {
		const demo = previewDemoSettingsSchema.parse({
			environment: "demo",
			seed: "pnpm db:seed:demo",
		});
		expect(reproduceDataOf({ environment: "dev", demo })).toEqual({
			kind: "demo",
			environment: "demo",
			seed: "pnpm db:seed:demo",
		});
	});

	it("else the environment its dev server already uses", () => {
		expect(reproduceDataOf({ environment: "dev" })).toEqual({
			kind: "environment",
			environment: "dev",
		});
	});

	it("refuses a demo setting that names nothing", () => {
		expect(previewDemoSettingsSchema.safeParse({}).success).toBe(false);
	});
});

describe("the reporter's confirm (BC-20)", () => {
	it("takes fixed alone, and not fixed only with what is still wrong", () => {
		expect(
			confirmFixRequestSchema.safeParse({ verdict: "fixed" }).success,
		).toBe(true);
		const r = confirmFixRequestSchema.safeParse({ verdict: "not_fixed" });
		expect(r.success).toBe(false);
		expect(r.error?.issues[0]?.message).toMatch(
			/^PREVIEW_CONFIRM_REASON_REQUIRED/,
		);
	});
});

describe("REQ-41's names live in REQ-39's registry", () => {
	it("answers the open and confirm routes and their refusals from the one registry", () => {
		expect(PREVIEW_ROUTES.ofProject).toBe("/api/projects/:id/previews");
		expect(PREVIEW_ROUTES.confirm).toBe("/api/previews/:id/confirm");
		for (const c of [
			"PREVIEW_ITEM_UNKNOWN",
			"PREVIEW_BUILD_UNKNOWN",
			"PREVIEW_CONFIRM_NOT_FIX",
			"PREVIEW_CONFIRM_REASON_REQUIRED",
		])
			expect(PREVIEW_REFUSAL_CODES as readonly string[]).toContain(c);
	});

	it("reads demo data from the project's preview setting (BC-22)", () => {
		const s = previewSettingsSchema.parse({
			command: "pnpm dev --port {port}",
			environment: "dev",
			demo: { environment: "demo", seed: "pnpm seed:demo" },
		});
		expect(reproduceDataOf(s)).toEqual({
			kind: "demo",
			environment: "demo",
			seed: "pnpm seed:demo",
		});
		expect(
			previewSettingsSchema.safeParse({ command: "x {port}", demo: {} })
				.success,
		).toBe(false);
	});

	it("carries what a preview serves, and no issue for one no issue holds", () => {
		const reproduce = previewRecordSchema.shape.subject.parse({
			kind: "reproduce",
			feedback: "FB-52",
			build: { sha: SHA, release: "1.4.0" },
			record: true,
		});
		expect(reproduce.kind).toBe("reproduce");
		expect(previewRecordSchema.shape.issueId.safeParse(null).success).toBe(
			true,
		);
		expect(previewRecordSchema.shape.sessionId.safeParse(null).success).toBe(
			true,
		);
	});
});
