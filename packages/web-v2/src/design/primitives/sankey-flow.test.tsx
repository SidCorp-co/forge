// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SankeyFlow } from "./sankey-flow";

afterEach(cleanup);

const nodes = [
  { key: "code", label: "code", count: 40, medianSeconds: 600 },
  { key: "review", label: "review", count: 30, medianSeconds: 120 },
  { key: "fix", label: "fix", count: 12, medianSeconds: 300, loop: true },
];

const draw = () =>
  render(
    <SankeyFlow
      nodes={nodes}
      label="Jobs by stage."
      formatDuration={(s) => (s === null ? "—" : `${s}s`)}
    />,
  );

describe("SankeyFlow", () => {
  it("renders nothing without nodes", () => {
    const { container } = render(
      <SankeyFlow nodes={[]} label="x" formatDuration={() => "—"} />,
    );
    expect(container.firstChild).toBeNull();
  });

  // cm:guard `fix` is work re-entering the pipeline, so it is drawn on its own path back and NOT as one more forward bar — laying it inline claims the pipeline has a stage it does not (ISS-988 criterion 38)
  it("draws the loop node apart from the forward chain", () => {
    const { container } = draw();
    expect(container.querySelectorAll("rect").length).toBe(2);
    expect(container.querySelectorAll("path[stroke-dasharray]").length).toBe(1);
  });

  // cm:guard the figures are carried in a TABLE beside the drawing, not a tooltip: criterion 38 asks for them in text for a reader who cannot see it (ISS-988)
  it("carries every node's figures in text, the loop included", () => {
    draw();
    for (const n of nodes) {
      expect(screen.getByText(n.label)).toBeTruthy();
      expect(screen.getByText(String(n.count))).toBeTruthy();
    }
    expect(screen.getByText(/loops back/)).toBeTruthy();
  });

  it("says so rather than printing a zero where nothing finished", () => {
    render(
      <SankeyFlow
        nodes={[{ key: "code", label: "code", count: 1, medianSeconds: null }]}
        label="x"
        formatDuration={(s) => (s === null ? "—" : `${s}s`)}
      />,
    );
    expect(screen.getByText("—")).toBeTruthy();
  });
});
