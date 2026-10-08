import { describe, expect, it } from "vitest";
import type { DeliveryForecast } from "./forecast.js";
import type { ProjectStatus, StatusWait } from "./project-status.js";
import type { ReportDocument } from "./report-templates.js";
import {
	deliveryDateOf,
	reportDocumentMarkdown,
	STATUS_DATE_MOVE_MIN_MINUTES,
	statusReportDiff,
	templateTitleOf,
	unwrittenSlots,
} from "./status-reports.js";
import { blockToText } from "./visual-blocks.js";

// What changed between two stored status reports is read from the two of them: a release the newer
// one lists and the older did not, an item newly late, a wait gone, and a dated forecast that moved
// by a day or more. Planted: two reports a week apart, one issue shipped and the release date moved.

const DAY = 86_400_000;
const at = (d: number) =>
	new Date(Date.UTC(2026, 9, 1) + d * DAY).toISOString();

function delivery(p50At: string): DeliveryForecast {
	return {
		label: "forecast",
		asOf: at(0),
		landing: {
			label: "forecast",
			asOf: at(0),
			kind: "landed",
			landedAt: at(0),
		},
		release: null,
		inHands: { p50At, p85At: p50At, p50Minutes: 60, p85Minutes: 90 },
		shipped: null,
	} as DeliveryForecast;
}

function wait(key: string): StatusWait {
	return {
		area: "issues",
		entity: "issue",
		key,
		title: key,
		waitingOn: { kind: "person" },
		touchedAt: null,
	} as unknown as StatusWait;
}

function report(o: {
	asOf: string;
	releases: { version: string; issues: string[] }[];
	nextDate: string | null;
	late?: string[];
	waits?: StatusWait[];
	peopleCount?: number;
}): ProjectStatus {
	const releases = o.releases.map((r) => ({
		version: r.version,
		releasedAt: o.asOf,
		headline: "",
		issueCount: r.issues.length,
		requirements: [],
		contents: [
			{
				requirement: null,
				issues: r.issues.map((key) => ({ key, title: `${key} title` })),
			},
		],
		verified: { level: "none", proven: 0, total: 0 },
	}));
	const waits = o.waits ?? [];
	return {
		asOf: o.asOf,
		days: 7,
		shipped: {
			asOf: o.asOf,
			since: o.asOf,
			latest: releases[0] ?? null,
			releases,
			releaseCount: releases.length,
			issueCount: 0,
			requirementsShipped: [],
		},
		late: {
			asOf: o.asOf,
			items: (o.late ?? []).map((key) => ({
				kind: "requirement",
				key,
				title: key,
				late: { reason: "p85_passed", since: o.asOf, byMinutes: 60 },
			})),
		},
		waits: {
			asOf: o.asOf,
			people: waits,
			peopleCount: o.peopleCount ?? waits.length,
			needsYou: 0,
		},
		requirements: { asOf: o.asOf, proven: 0, total: 0, byState: [], items: [] },
		nextRelease: {
			asOf: o.asOf,
			version: "0.4.0",
			state: "draft",
			progress: { total: 1, shipped: 0, awaitingRelease: 1, toDo: 0 },
			requirements: [],
			forecast: o.nextDate
				? ({
						delivery: delivery(o.nextDate),
					} as ProjectStatus["nextRelease"]["forecast"])
				: null,
			turn: null,
			behind: null,
		},
	} as unknown as ProjectStatus;
}

describe("what changed since the last status report", () => {
	const lastWeek = report({
		asOf: at(0),
		releases: [{ version: "0.3.0", issues: ["ISS-1"] }],
		nextDate: at(10),
		waits: [wait("ISS-7"), wait("ISS-8")],
	});
	const now = report({
		asOf: at(7),
		releases: [
			{ version: "0.3.1", issues: ["ISS-2"] },
			{ version: "0.3.0", issues: ["ISS-1"] },
		],
		nextDate: at(13),
		late: ["REQ-4"],
		waits: [wait("ISS-8")],
	});

	it("names the issue shipped since and the release date moved, old to new", () => {
		const diff = statusReportDiff(lastWeek, now);
		expect(diff.since).toBe(at(0));
		expect(diff.shipped).toEqual([
			{
				version: "0.3.1",
				releasedAt: at(7),
				issues: [{ key: "ISS-2", title: "ISS-2 title" }],
			},
		]);
		expect(diff.moved).toEqual([
			{
				kind: "release",
				key: "0.4.0",
				title: "0.4.0",
				from: at(10),
				to: at(13),
			},
		]);
	});

	it("names what is newly late and what no longer waits on a person", () => {
		const diff = statusReportDiff(lastWeek, now);
		expect(diff.newlyLate.map((l) => l.key)).toEqual(["REQ-4"]);
		expect(diff.noLongerWaiting.map((w) => w.key)).toEqual(["ISS-7"]);
		expect(diff.waitsCut).toBe(false);
	});

	it("claims nothing gone from a waits list cut at its cap", () => {
		const cut = report({
			asOf: at(7),
			releases: [],
			nextDate: at(10),
			waits: [wait("ISS-8")],
			peopleCount: 30,
		});
		const diff = statusReportDiff(lastWeek, cut);
		expect(diff.noLongerWaiting).toEqual([]);
		expect(diff.waitsCut).toBe(true);
	});

	it("reads a date shifted by less than a day as not moved, and a day or more as moved", () => {
		const under = STATUS_DATE_MOVE_MIN_MINUTES * 60_000 - 60_000;
		const nearly = report({
			asOf: at(7),
			releases: [],
			nextDate: new Date(Date.parse(at(10)) + under).toISOString(),
		});
		expect(statusReportDiff(lastWeek, nearly).moved).toEqual([]);
		const day = report({ asOf: at(7), releases: [], nextDate: at(11) });
		expect(statusReportDiff(lastWeek, day).moved).toHaveLength(1);
	});

	it("says nothing moved where either report holds no date, and nothing changed between a report and itself", () => {
		const undated = report({ asOf: at(7), releases: [], nextDate: null });
		expect(statusReportDiff(lastWeek, undated).moved).toEqual([]);
		const same = statusReportDiff(lastWeek, lastWeek);
		expect([
			same.shipped,
			same.newlyLate,
			same.noLongerWaiting,
			same.moved,
		]).toEqual([[], [], [], []]);
	});

	it("dates a delivery by what was shipped, else the in-hands p50, else nothing", () => {
		expect(deliveryDateOf(null)).toBeNull();
		expect(deliveryDateOf(delivery(at(3)))).toBe(at(3));
		expect(
			deliveryDateOf({
				...delivery(at(3)),
				shipped: { version: "0.3.0", at: at(1) },
			}),
		).toBe(at(1));
	});
});

describe("a kept template report as Markdown", () => {
	const frame = {
		fields: [
			{ name: "requirement", type: "ref" as const, label: "Requirement" },
			{ name: "proven", type: "number" as const, label: "Proven" },
		],
		rows: [{ requirement: "REQ-7", proven: 5 }],
	};
	const document: ReportDocument = {
		templateId: "progress",
		version: 1,
		params: {},
		runs: [],
		blocks: [
			{
				kind: "table",
				v: 1,
				title: "Progress",
				columns: ["requirement", "proven"],
				source: { runId: "run-1" },
				frame,
			},
		],
		narrative: {
			summary: "One requirement moved.",
			risks: "",
			recommendations: "  ",
		},
	};

	it("writes the narrative first, each block as its plain text, and names the slots nobody wrote", () => {
		const text = reportDocumentMarkdown(document, {
			title: "Progress",
			asOf: "2026-10-08T09:00:00.000Z",
		});
		expect(
			text.startsWith(
				"# Progress\n\n_As of 2026-10-08T09:00:00.000Z_\n\n## Summary\n\nOne requirement moved.",
			),
		).toBe(true);
		expect(text).toContain(blockToText(document.blocks[0] as never));
		expect(text.indexOf("## Summary")).toBeLessThan(
			text.indexOf(blockToText(document.blocks[0] as never)),
		);
		expect(
			text
				.trimEnd()
				.endsWith("_Narrative not written: risks, recommendations._"),
		).toBe(true);
		expect(unwrittenSlots(document)).toEqual(["risks", "recommendations"]);
	});

	it("names no slot as unwritten when every one is written", () => {
		const all = {
			...document,
			narrative: { summary: "a", risks: "b", recommendations: "c" },
		};
		expect(
			reportDocumentMarkdown(all, { title: "Progress", asOf: "x" }),
		).not.toContain("not written");
	});

	it("titles a stored template this build no longer has by its id", () => {
		expect(templateTitleOf("progress")).not.toBe("progress");
		expect(templateTitleOf("retired")).toBe("retired");
	});
});
