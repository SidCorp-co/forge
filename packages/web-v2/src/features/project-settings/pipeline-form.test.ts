// ISS-1262: what the Pipeline page's draft owes the store. The draft is held in the document's own
// shape with the screen's defaults filled in, so the write must be the difference between two
// drafts, with `base` read from the stored document — a default the draft filled in is not a value
// somebody stored, and sending it as the base would refuse a save nobody else touched.

import { comparePatchBase } from "@forge/contracts/document-patch";
import { describe, expect, it } from "vitest";
import { type PipelineDraft, pipelineSchema, pipelineWrites, readPipeline } from "./pipeline-form";
import type { PipelineConfig } from "./types";

const STORED: PipelineConfig = {
	enabled: true,
	states: { open: { enabled: true, mode: "auto", disallowedTools: ["Bash(rm:*)"] } },
};

function edit(read: PipelineDraft, change: (d: PipelineDraft) => void): PipelineDraft {
	const held = structuredClone(read);
	change(held);
	return held;
}

describe("pipelineWrites", () => {
	it("owes nothing for a draft nobody touched, defaults and all", () => {
		const seeded = readPipeline(STORED, []);
		expect(pipelineWrites(seeded, structuredClone(seeded), STORED)).toEqual({
			config: null,
			plugins: null,
		});
	});

	it("names only the leaf that moved, and reads its base from the stored document", () => {
		const seeded = readPipeline(STORED, []);
		const held = edit(seeded, (d) => {
			d.intakeGate.enabled = true;
		});
		const { config } = pipelineWrites(seeded, held, STORED);

		expect(config?.patch).toEqual({ intakeGate: { enabled: true } });
		// Stored has no intakeGate at all: the screen's `notify: true` default is not a stored value.
		expect(config?.base).toEqual({});
		expect(comparePatchBase(STORED, config?.base, config?.patch ?? {})).toEqual([]);
	});

	it("carries the stored value at a leaf that is cleared, so a stale clear is refused", () => {
		const seeded = readPipeline(STORED, []);
		const held = edit(seeded, (d) => {
			(d.states.open as { disallowedTools: string[] }).disallowedTools = [];
		});
		const { config } = pipelineWrites(seeded, held, STORED);

		expect(config?.patch).toEqual({ states: { open: { disallowedTools: null } } });
		expect(config?.base).toEqual({ states: { open: { disallowedTools: ["Bash(rm:*)"] } } });
		const moved: PipelineConfig = {
			...STORED,
			states: { open: { disallowedTools: ["Bash(rm:*)", "WebFetch"] } },
		};
		expect(comparePatchBase(moved, config?.base, config?.patch ?? {})).toHaveLength(1);
	});

	it("takes two edits in two sections into one patch", () => {
		const seeded = readPipeline(STORED, []);
		const held = edit(seeded, (d) => {
			d.knowledgePromotion.minRetrievals = 7;
			d.states.open.deviceIds = ["box-a"];
		});
		expect(pipelineWrites(seeded, held, STORED).config?.patch).toEqual({
			knowledgePromotion: { minRetrievals: 7 },
			states: { open: { deviceIds: ["box-a"] } },
		});
	});

	it("does not take choosing the same boxes in another order for an edit", () => {
		const stored: PipelineConfig = { states: { open: { deviceIds: ["b", "a"] } } };
		const seeded = readPipeline(stored, []);
		expect(seeded.states.open?.deviceIds).toEqual(["a", "b"]);
		const held = edit(seeded, (d) => {
			(d.states.open as { deviceIds: string[] }).deviceIds = ["b", "a"].sort();
		});
		expect(pipelineWrites(seeded, held, stored).config).toBeNull();
	});

	it("sends the plugins whole, and only when they moved", () => {
		const seeded = readPipeline(STORED, [{ marketplace: "a/b", name: "forge" }]);
		expect(pipelineWrites(seeded, structuredClone(seeded), STORED).plugins).toBeNull();
		const held = edit(seeded, (d) => {
			d.plugins.push({ marketplace: "c/d", name: "other", pinnedRef: " abc1234 ", autoUpdate: true });
		});
		expect(pipelineWrites(seeded, held, STORED).plugins).toEqual([
			{ marketplace: "a/b", name: "forge", pinnedRef: null, autoUpdate: false },
			{ marketplace: "c/d", name: "other", pinnedRef: "abc1234", autoUpdate: true },
		]);
	});
});

describe("pipelineSchema", () => {
	const issues = (draft: PipelineDraft) => {
		const parsed = pipelineSchema.safeParse(draft);
		return parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
	};
	const base = () => readPipeline(STORED, []);

	it("accepts a draft read straight from a stored document", () => {
		expect(issues(base())).toEqual([]);
	});

	it("names an incomplete plugin row at the field", () => {
		const d = base();
		d.plugins = [{ marketplace: "", name: "forge" }];
		expect(issues(d)).toEqual(["plugins.0.marketplace: Marketplace is required."]);
	});

	it("names a plugin whose pinned ref is not a sha", () => {
		const d = base();
		d.plugins = [{ marketplace: "a/b", name: "forge", pinnedRef: "main" }];
		expect(issues(d)).toEqual(["plugins.0.pinnedRef: Pinned SHA must be 7–40 hex characters."]);
	});

	it("names a weekly reading that is on and incomplete, and not one that is off", () => {
		const d = base();
		d.assistantWeekly.enabled = true;
		expect(issues(d)).toEqual([expect.stringContaining("assistantWeekly.enabled: Fill in the pinned issue")]);
		d.assistantWeekly.enabled = false;
		expect(issues(d)).toEqual([]);
	});

	it("refuses Draft in the backlog only while the intake gate is on", () => {
		const d = base();
		d.poolBacklog.statuses = ["draft"];
		expect(issues(d)).toEqual([]);
		d.intakeGate.enabled = true;
		expect(issues(d)).toEqual([expect.stringContaining("poolBacklog.statuses:")]);
	});

	it("bounds the counts the screen states a maximum for", () => {
		const d = base();
		d.knowledgePromotion.candidatesPerRun = 11;
		d.poolBacklog.statuses = ["draft"];
		d.poolBacklog.limit = 0;
		expect(issues(d)).toEqual([
			"knowledgePromotion.candidatesPerRun: Proposals per night must be at most 10.",
			"poolBacklog.limit: Backlog rows must be at least 1.",
		]);
	});

	it("does not bound a backlog limit while no status is admitted, since it is neither shown nor written", () => {
		const d = base();
		d.poolBacklog.limit = 0;
		expect(issues(d)).toEqual([]);
	});
});
