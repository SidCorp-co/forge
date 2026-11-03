// @direct-test-of packages/web-v2/patches/@excalidraw__mermaid-to-excalidraw@2.2.2.patch
// @direct-test-of package.json
// A mermaid definition pasted on the board (or entered in Excalidraw's mermaid dialog) goes through
// `parseMermaidToExcalidraw`, which renders the diagram with mermaid and then finds each node and edge
// of the rendered SVG by its element id. Mermaid 11.14 prefixed every such id with the SVG's own id
// (`mermaid-to-excalidraw-0-classId-Issue-0`), and the converter's class, ER and state parsers and
// its flowchart subgraphs look the bare id up, so those fell back to a single image (ISS-911). Each
// diagram here must come back as editable element skeletons, never the `graphImage` fallback.

import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const DIAGRAMS = {
  class: "classDiagram\n  class Issue {\n    +key string\n  }\n  Issue <|-- Defect",
  er: "erDiagram\n  ISSUE ||--o{ COMMENT : has\n  ISSUE {\n    string key\n  }",
  flowchart: "flowchart LR\n  A[Issue] --> B{Built?}\n  B -->|yes| C[Released]\n  B -->|no| A",
  sequence: "sequenceDiagram\n  Master->>Builder: brief\n  Builder-->>Master: report",
  state: "stateDiagram-v2\n  [*] --> Open\n  Open --> Closed: release\n  Closed --> [*]",
  subgraph: "flowchart LR\n  subgraph Batch\n    A[Build] --> B[Gate]\n  end\n  B --> C[Release]",
} as const;

// cm:why jsdom lays nothing out: SVG elements have no getBBox and text has no measured length, and
// mermaid sizes every node from them. A box sized from the element's text is enough for the layout
// to run; what this test asserts is which elements the converter finds, not where they sit.
type Measured = { getBBox?: () => DOMRect; getComputedTextLength?: () => number };
const proto = SVGElement.prototype as unknown as Measured;
const saved = { getBBox: proto.getBBox, getComputedTextLength: proto.getComputedTextLength };

beforeAll(() => {
  proto.getBBox = function (this: Element) {
    const width = Math.max(8, (this.textContent ?? "").length * 8);
    return { x: 0, y: 0, width, height: 16, top: 0, left: 0, right: width, bottom: 16, toJSON: () => ({}) };
  };
  proto.getComputedTextLength = function (this: Element) {
    return (this.textContent ?? "").length * 8;
  };
});

afterAll(() => {
  proto.getBBox = saved.getBBox;
  proto.getComputedTextLength = saved.getComputedTextLength;
});

// cm:why the converter's own declarations import `@excalidraw/excalidraw/element/transform`, a path
// 0.18.1 does not ship, so its result type does not resolve; this is the part of it read here
type Converted = {
  elements: readonly { type: string; text?: unknown; label?: { text?: unknown } }[];
  files?: Record<string, { dataURL: string }>;
};

const textsOf = (result: Converted) =>
  result.elements.flatMap((e) => [e.text, e.label?.text]).filter((t): t is string => typeof t === "string");

async function convert(definition: string) {
  const errors: unknown[][] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args);
  });
  try {
    const result = (await parseMermaidToExcalidraw(definition)) as unknown as Converted;
    return { result, errors };
  } finally {
    spy.mockRestore();
  }
}

describe("a mermaid diagram pasted on the board converts to editable elements (ISS-911)", () => {
  it("a class diagram becomes its classes' boxes and texts, not an image", async () => {
    const { result, errors } = await convert(DIAGRAMS.class);
    expect(errors.map((e) => String(e[1] ?? e[0]))).toEqual([]);
    expect(result.elements.some((e) => e.type === "image")).toBe(false);
    const texts = textsOf(result);
    expect(texts.join("\n")).toContain("Issue");
    expect(texts.join("\n")).toContain("Defect");
    expect(result.elements.some((e) => e.type === "arrow")).toBe(true);
  });

  it("an ER diagram becomes its entities and relationship, not an image", async () => {
    const { result, errors } = await convert(DIAGRAMS.er);
    expect(errors.map((e) => String(e[1] ?? e[0]))).toEqual([]);
    expect(result.elements.some((e) => e.type === "image")).toBe(false);
    const texts = textsOf(result);
    expect(texts.join("\n")).toContain("ISSUE");
    expect(texts.join("\n")).toContain("COMMENT");
    expect(result.elements.some((e) => e.type === "arrow")).toBe(true);
  });

  it.each([
    ["a state diagram", DIAGRAMS.state, "Closed"],
    ["a flowchart subgraph", DIAGRAMS.subgraph, "Batch"],
  ])("%s, found by the same prefixed ids, converts", async (_kind, definition, name) => {
    const { result, errors } = await convert(definition);
    expect(errors.map((e) => String(e[1] ?? e[0]))).toEqual([]);
    expect(result.elements.some((e) => e.type === "image")).toBe(false);
    expect(textsOf(result).join("\n")).toContain(name);
  });

  it("a flowchart and a sequence diagram still convert", async () => {
    for (const definition of [DIAGRAMS.flowchart, DIAGRAMS.sequence]) {
      const { result, errors } = await convert(definition);
      expect(errors.map((e) => String(e[1] ?? e[0]))).toEqual([]);
      expect(result.elements.some((e) => e.type === "image")).toBe(false);
      expect(result.elements.length).toBeGreaterThan(3);
    }
  });

  it("a diagram kept as an image keeps its render-prefixed ids, so its own url(#…) references resolve", async () => {
    const { result } = await convert("journey\n  title Ship\n  section Build\n    Code: 5: Builder");
    const dataURLs = Object.values(result.files ?? {}).map((f) => f.dataURL);
    expect(dataURLs).toHaveLength(1);
    const svg = atob((dataURLs[0] ?? "").replace(/^data:image\/svg\+xml;base64,/, ""));
    const [root, ...inner] = [...svg.matchAll(/ id="([^"]*)"/g)].map((m) => m[1] ?? "");
    expect(root).toMatch(/^mermaid-to-excalidraw-\d+$/);
    expect(inner).toContain(`${root}-arrowhead`);
    expect(inner.filter((id) => !id.startsWith(`${root}-`))).toEqual([]);
  });
});
