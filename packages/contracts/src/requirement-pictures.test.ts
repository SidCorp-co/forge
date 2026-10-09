// REQ-35 (ISS-459): what a picture may hold, per kind. A body of the wrong shape is refused at the
// door naming the field; a rule's blank cell passes here so core can refuse it by name.

import { describe, expect, it } from "vitest";
import { PICTURE_KIND_OF, REQUIREMENT_KINDS, writePictureRequestSchema } from "./requirement-pictures.js";

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
