// REQ-35 (ISS-459): what a picture may hold, per kind. A body of the wrong shape is refused at the
// door naming the field; a rule's blank cell passes here so core can refuse it by name.

import { describe, expect, it } from "vitest";
import {
	type DraftPicture,
	describePicture,
	draftPictureSchema,
	PICTURE_KIND_OF,
	pictureWithAlt,
	REQUIREMENT_KINDS,
	REQUIREMENT_PICTURE_LIMITS,
	writePictureRequestSchema,
} from "./requirement-pictures.js";

const parse = (body: unknown) => writePictureRequestSchema.safeParse(body);
const issuesOf = (body: unknown) => {
	const r = parse(body);
	return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("each kind's picture", () => {
	it("names one picture kind per requirement kind", () => {
		expect(REQUIREMENT_KINDS.map((k) => PICTURE_KIND_OF[k])).toEqual(["flow", "example_table", "wireframe", "chart"]);
	});

	it("takes a rough flow, and refuses an edge to a node it does not hold", () => {
		const flow = { nodes: [{ id: "a", label: "Order" }, { id: "b", label: "Ship" }], edges: [{ from: "a", to: "b" }] };
		expect(parse({ kind: "flow", alt: "Order, then ship.", content: flow }).success).toBe(true);
		const dangling = { ...flow, edges: [{ from: "a", to: "z" }] };
		expect(issuesOf({ kind: "flow", alt: "x", content: dangling }).join("\n")).toContain("z");
	});

	it("takes a sample chart over its own figures, and refuses a field its frame lacks", () => {
		const frame = {
			fields: [
				{ name: "week", label: "Week", type: "string" },
				{ name: "orders", label: "Orders", type: "number" },
			],
			rows: [
				{ week: "W1", orders: 3 },
				{ week: "W2", orders: 5 },
			],
		};
		const chart = { variant: "bar", x: "week", y: ["orders"], frame };
		expect(parse({ kind: "chart", alt: "Orders rise.", content: chart }).success).toBe(true);
		expect(issuesOf({ kind: "chart", alt: "x", content: { ...chart, y: ["refunds"] } }).join("\n")).toContain("refunds");
	});

	it("takes a wireframe-v1 board, and refuses one that is not", () => {
		const board = { v: "wireframe-v1", shapes: [{ id: "f", type: "frame", x: 10, y: 10, w: 300, h: 200 }] };
		expect(parse({ kind: "wireframe", alt: "One frame.", content: { board } }).success).toBe(true);
		expect(issuesOf({ kind: "wireframe", alt: "x", content: { board: { v: "wireframe-v0", shapes: [] } } }).join("\n")).toContain(
			"WIREFRAME_INVALID",
		);
	});

	it("takes an example table with a blank cell, which core refuses by name", () => {
		expect(parse({ kind: "example_table", alt: "x", content: { rows: [{ input: "1 item" }] } }).success).toBe(true);
	});

	it("refuses content of another kind's shape", () => {
		expect(parse({ kind: "example_table", alt: "x", content: { nodes: [], edges: [] } }).success).toBe(false);
	});
});

// ISS-464 (REQ-35 BC-10, BC-12): the picture a draft carries, whose text alternative the assistant
// leaves to be written from what the picture holds.
const DRAWN: Record<string, DraftPicture> = {
	flow: {
		kind: "flow",
		content: {
			title: "Refund",
			nodes: [
				{ id: "ask", label: "Buyer asks" },
				{ id: "ok", label: "Refund paid" },
			],
			edges: [{ from: "ask", to: "ok", label: "within 14 days" }],
		},
	},
	example_table: {
		kind: "example_table",
		content: { rows: [{ input: "A cart of 3 items", expected: "Shipping is free" }] },
	},
	wireframe: {
		kind: "wireframe",
		content: {
			board: {
				v: "wireframe-v1",
				title: "Checkout",
				shapes: [
					{ id: "t", type: "text", x: 10, y: 10, w: 200, h: 20, text: "Your cart" },
					{ id: "b", type: "button", x: 10, y: 40, w: 80, h: 30, label: "Pay" },
				],
			},
		},
	},
	chart: {
		kind: "chart",
		content: {
			variant: "bar",
			x: "week",
			y: ["orders"],
			frame: {
				fields: [
					{ name: "week", label: "Week", type: "string" },
					{ name: "orders", label: "Orders", type: "number" },
				],
				rows: [{ week: "W1", orders: 3 }],
			},
		},
	},
};

describe("the picture a draft carries", () => {
	it("takes no text alternative, and refuses a key the picture does not hold", () => {
		expect(draftPictureSchema.safeParse(DRAWN.flow).success).toBe(true);
		expect(draftPictureSchema.safeParse({ ...DRAWN.flow, caption: "x" }).success).toBe(false);
	});

	it.each(Object.keys(DRAWN))("writes a %s picture's text alternative from what it holds", (kind) => {
		const alt = describePicture(DRAWN[kind] as DraftPicture);
		expect(alt.trim()).not.toBe("");
		expect(alt.length).toBeLessThanOrEqual(REQUIREMENT_PICTURE_LIMITS.altChars);
	});

	it("says each picture's own words", () => {
		expect(describePicture(DRAWN.flow as DraftPicture)).toBe("Refund: a flow of 2 steps: Buyer asks to Refund paid (within 14 days).");
		expect(describePicture(DRAWN.example_table as DraftPicture)).toBe("An example table of 1 row: A cart of 3 items gives Shipping is free.");
		expect(describePicture(DRAWN.wireframe as DraftPicture)).toBe('A wireframe "Checkout": "Your cart", a Pay button.');
		expect(describePicture(DRAWN.chart as DraftPicture)).toBe("A sample bar chart of Orders by Week, from 1 sample row.");
	});

	it("counts a board of bare shapes rather than say nothing", () => {
		const bare = { kind: "wireframe", content: { board: { v: "wireframe-v1", shapes: [{ id: "f", type: "frame", x: 1, y: 1, w: 9, h: 9 }] } } };
		expect(describePicture(bare as DraftPicture)).toBe("A wireframe: 1 shape.");
	});

	it("cuts a long one to the alt limit", () => {
		const rows = Array.from({ length: 40 }, (_, i) => ({ input: `input number ${i}`, expected: `result number ${i}` }));
		const alt = describePicture({ kind: "example_table", content: { rows } });
		expect(alt).toHaveLength(REQUIREMENT_PICTURE_LIMITS.altChars);
		expect(alt.endsWith("…")).toBe(true);
	});

	it("keeps an alt the draft wrote, and writes one where it wrote none", () => {
		expect(pictureWithAlt({ ...(DRAWN.flow as DraftPicture), alt: "Refunds are paid." }).alt).toBe("Refunds are paid.");
		const written = pictureWithAlt(DRAWN.flow as DraftPicture);
		expect(written.alt).toBe(describePicture(DRAWN.flow as DraftPicture));
		expect(writePictureRequestSchema.safeParse(written).success).toBe(true);
	});
});
