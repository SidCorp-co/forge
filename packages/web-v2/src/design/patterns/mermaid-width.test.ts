// @vitest-environment jsdom
//
// Mermaid draws a diagram to fit its column, so one wider than the column is shrunk until its
// text cannot be read: judge j16 measured the generated user flow's labels at 4px at 1280 and
// under 2px at 390 (ISS-1229). A diagram is drawn no narrower than three quarters of its own
// width, which keeps mermaid's 16px labels at 12px, and scrolls inside its box past that.

import { cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { diagramMinWidth, MIN_DIAGRAM_SCALE } from "./mermaid-width";

vi.mock("mermaid", () => ({
	default: {
		initialize: vi.fn(),
		parse: vi.fn(async () => true),
		render: vi.fn(async () => ({
			svg: '<svg id="d" width="100%" viewBox="0 0 3126 400" style="max-width: 3126px;"><text>a</text></svg>',
		})),
	},
}));

const { MermaidDiagram } = await import("./mermaid");

afterEach(cleanup);

describe("how narrow a diagram may be drawn", () => {
	it("keeps mermaid's 16px labels at 12px or larger", () => {
		expect(16 * MIN_DIAGRAM_SCALE).toBeGreaterThanOrEqual(12);
	});

	it("is three quarters of the width the diagram is drawn at", () => {
		expect(diagramMinWidth("0 0 3126 400")).toBe(2345);
		expect(diagramMinWidth("-8 -8 2182.0625 700")).toBe(1637);
	});

	it("rounds up, so the floor is never under the scale", () => {
		expect(diagramMinWidth("0 0 1 1")).toBe(1);
		expect(diagramMinWidth("0 0 4 1")).toBe(3);
	});

	it("sets no floor where the svg carries no width it can be read from", () => {
		expect(diagramMinWidth(null)).toBeNull();
		expect(diagramMinWidth("")).toBeNull();
		expect(diagramMinWidth("0 0 0 0")).toBeNull();
		expect(diagramMinWidth("0 0 wide 1")).toBeNull();
		expect(diagramMinWidth("0 0 -20 10")).toBeNull();
	});
});

describe("a drawn diagram", () => {
	it("is held at its floor and scrolls inside its own box rather than shrinking", async () => {
		const { container } = render(createElement(MermaidDiagram, { code: "flowchart LR\n a --> b" }));

		const svg = await waitFor(() => {
			const found = container.querySelector("svg");
			if (!found) throw new Error("not drawn yet");
			return found;
		});
		expect(svg.style.minWidth).toBe("2345px");
		const box = svg.parentElement as HTMLElement;
		expect(box.className).toMatch(/\boverflow-x-auto\b/);
		expect(box.className).toMatch(/\bmax-w-full\b/);
	});
});
