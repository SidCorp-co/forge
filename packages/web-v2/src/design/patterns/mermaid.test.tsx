// @vitest-environment jsdom
//
// One proposition: the diagram survives React's dev double-invoke. The bug this
// stands against left every mermaid diagram on the site — issue bodies, comments,
// knowledge entries — as a grey skeleton in `next dev` and nowhere else, so it
// read as "mermaid is broken on this machine" rather than as a defect.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MermaidDiagram } from "./mermaid";

expect.extend(matchers);
afterEach(cleanup);

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    parse: vi.fn(async () => true),
    render: vi.fn(async (id: string) => ({ svg: `<svg id="${id}"><title>drawn</title></svg>` })),
  },
}));

describe("MermaidDiagram", () => {
  it("draws under React's dev double-invoke, not just on a single mount", async () => {
    const { container } = render(
      <StrictMode>
        <MermaidDiagram code="flowchart LR\n  A --> B" />
      </StrictMode>,
    );
    await waitFor(() => expect(container.querySelector("svg")).not.toBeNull());
    expect(container.querySelector("div.animate-pulse")).toBeNull();
  });

  it("names the parse failure instead of leaving a skeleton", async () => {
    const mermaid = (await import("mermaid")).default;
    vi.mocked(mermaid.parse).mockRejectedValueOnce(new Error("no diagram type detected"));
    const { container } = render(<MermaidDiagram code="not a diagram" />);
    await waitFor(() =>
      expect(container.textContent).toContain("no diagram type detected"),
    );
  });
});
