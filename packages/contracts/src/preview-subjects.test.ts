import { describe, expect, it } from "vitest";
import {
	confirmFixRequestSchema,
	keptPreviewContentSchema,
	openPreviewRequestSchema,
	PREVIEW_REFUSAL_CODES,
	PREVIEW_ROUTES,
	PREVIEW_SUBJECT_REFUSAL_CODES,
	PREVIEW_SUBJECT_ROUTES,
	previewDemoSettingsSchema,
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
	const kept = {
		previewId: UUID,
		base: SHA,
		patchId: SHA,
		files: ["packages/web-v2/src/app/page.tsx"],
		shots: [{ upload: UUID, alt: "The home with a larger chat box" }],
		asked: ["Make the chat box larger"],
	};

	it("holds the change, its screenshots and what was asked", () => {
		expect(keptPreviewContentSchema.safeParse(kept).success).toBe(true);
	});

	it("refuses a kept preview with no screenshot: a picture shows something", () => {
		expect(
			keptPreviewContentSchema.safeParse({ ...kept, shots: [] }).success,
		).toBe(false);
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

describe("the additions do not collide with REQ-39's names", () => {
	it("adds codes and routes REQ-39 does not have", () => {
		for (const c of PREVIEW_SUBJECT_REFUSAL_CODES)
			expect(PREVIEW_REFUSAL_CODES as readonly string[]).not.toContain(c);
		const taken = new Set(Object.values(PREVIEW_ROUTES));
		for (const r of Object.values(PREVIEW_SUBJECT_ROUTES))
			expect(taken.has(r as never)).toBe(false);
	});
});
