// @vitest-environment jsdom
//
// ISS-1083 — a tool card says what came back instead of showing it. Before this the whole of the
// answer was `JSON.stringify(result).slice(0, 240)` printed inline, which on a real turn read
// `{"project":{"id":"e4fc92b3-e524-496d-abc1-98c2510e7dc4","slug":"erp","name":"ERP","descriptio`
// under a horizontal scrollbar.
//
// Matchers are extended on vitest's OWN `expect` for the reason `thinking-line.test.tsx` gives.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolCallData } from "../types";
import { ToolCard } from "./tool-card";

expect.extend(matchers);

afterEach(cleanup);

const call = (over: Partial<ToolCallData> = {}): ToolCallData => ({
  id: "t1",
  name: "forge_projects_get",
  input: { slug: "erp" },
  durationMs: 1,
  ...over,
});

const PROJECT = {
  project: {
    id: "e4fc92b3-e524-496d-abc1-98c2510e7dc4",
    slug: "erp",
    name: "ERP",
    description: "the long one",
  },
};

describe("what a settled card says", () => {
  it("names the shape of an object and shows none of it", () => {
    render(<ToolCard tool={call({ result: PROJECT })} />);
    expect(screen.getByTestId("tool-result-summary")).toHaveTextContent("Object · 1 field");
    expect(screen.queryByTestId("tool-result-body")).toBeNull();
    // The defect, asserted directly: no fragment of the serialized value on screen.
    expect(document.body.textContent).not.toContain("e4fc92b3");
  });

  it("counts an array's items", () => {
    render(<ToolCard tool={call({ result: [1, 2, 3, 4] })} />);
    expect(screen.getByTestId("tool-result-summary")).toHaveTextContent("Array · 4 items");
  });

  it("says an empty array is empty rather than saying nothing", () => {
    render(<ToolCard tool={call({ result: [] })} />);
    expect(screen.getByTestId("tool-result-summary")).toHaveTextContent("Array · 0 items");
  });

  it("measures a string rather than quoting it", () => {
    render(<ToolCard tool={call({ result: "a".repeat(86) })} />);
    expect(screen.getByTestId("tool-result-summary")).toHaveTextContent("Text · 86 characters");
  });

  it("says a call that returned nothing returned nothing", () => {
    render(<ToolCard tool={call({ result: null })} />);
    expect(screen.getByTestId("tool-result-summary")).toHaveTextContent("No result");
  });

  it("says an empty string is an empty answer and not a missing one", () => {
    render(<ToolCard tool={call({ result: "" })} />);
    expect(screen.getByTestId("tool-result-summary")).toHaveTextContent("No result");
  });
});

describe("what a card with no output says", () => {
  const outputless = call({ result: undefined, durationMs: undefined });

  it("says it is running while the turn is still arriving", () => {
    render(<ToolCard tool={outputless} live />);
    expect(screen.getByTestId("tool-result-summary")).toHaveTextContent("Running…");
  });

  it("does not claim to be running on a turn that has finished", () => {
    render(<ToolCard tool={outputless} />);
    const summary = screen.getByTestId("tool-result-summary");
    expect(summary).toHaveTextContent("No output recorded");
    expect(summary.textContent).not.toContain("Running");
  });

  it("offers no body to open in either state", () => {
    const { unmount } = render(<ToolCard tool={outputless} live />);
    expect(screen.queryByTestId("tool-result-toggle")).toBeNull();
    unmount();
    render(<ToolCard tool={outputless} />);
    expect(screen.queryByTestId("tool-result-toggle")).toBeNull();
  });
});

describe("what a failed card says", () => {
  it("says that it failed", () => {
    render(<ToolCard tool={call({ isError: true, result: "ENOENT: no such file" })} />);
    expect(screen.getByTestId("tool-result-summary")).toHaveTextContent("Failed");
  });

  it("shows what the error was", () => {
    render(<ToolCard tool={call({ isError: true, result: "ENOENT: no such file" })} />);
    expect(screen.getByTestId("tool-result-summary")).toHaveTextContent("ENOENT: no such file");
  });

  it("still says that it failed when there is no message to show", () => {
    render(<ToolCard tool={call({ isError: true, result: null })} />);
    expect(screen.getByTestId("tool-result-summary")).toHaveTextContent("Failed");
  });
});

describe("the whole value, on request", () => {
  it("opens onto it, pretty-printed", () => {
    render(<ToolCard tool={call({ result: PROJECT })} />);
    fireEvent.click(screen.getByTestId("tool-result-toggle"));
    const body = screen.getByTestId("tool-result-body");
    expect(body).toHaveTextContent("e4fc92b3-e524-496d-abc1-98c2510e7dc4");
    // Pretty-printed means the keys are on their own lines, which minified JSON never is.
    expect(body.textContent).toContain('\n  "project"');
  });

  it("opens onto the whole of a long value rather than 240 characters of it", () => {
    const long = { note: "x".repeat(5_000) };
    render(<ToolCard tool={call({ result: long })} />);
    fireEvent.click(screen.getByTestId("tool-result-toggle"));
    expect(screen.getByTestId("tool-result-body").textContent).toContain("x".repeat(5_000));
  });

  it("wraps rather than widening the thread", () => {
    render(<ToolCard tool={call({ result: PROJECT })} />);
    fireEvent.click(screen.getByTestId("tool-result-toggle"));
    const cls = screen.getByTestId("tool-result-body").getAttribute("class") ?? "";
    expect(cls).toMatch(/break-all|break-words|overflow-wrap/);
  });
});
