// @vitest-environment jsdom
//
// ISS-813 — read-only display of states[*].disallowedTools/allowedTools/
// mcpServers/skipComplexities/sessionGroup. Pure component (no query of its
// own), so tested directly with fixture configs rather than mocked hooks.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StagePermissionsSection } from "./components/stage-permissions-section";
import type { PipelineConfig } from "./types";

expect.extend(matchers);
afterEach(cleanup);

/** Rows are Collapsibles — collapsed by default (AC: 176 entries stay legible).
 *  Expand the one carrying `statusTag` before asserting on its body content. */
function expandRow(statusTag: string) {
  fireEvent.click(screen.getByText(statusTag).closest("button") as HTMLElement);
}

const DENYLIST_FULL = [
  "mcp__forge__forge_projects_archive",
  "mcp__forge__forge_pm_set_dependency",
  "mcp__forge__forge_uploads",
  "CronCreate",
];

const FORGE_DEV_SHAPED: PipelineConfig = {
  states: {
    open: { disallowedTools: DENYLIST_FULL, sessionGroup: "planning" },
    confirmed: {
      disallowedTools: DENYLIST_FULL.filter((t) => t !== "mcp__forge__forge_uploads"),
      skipComplexities: ["xs", "s"],
    },
    clarified: {
      disallowedTools: DENYLIST_FULL.filter((t) => t !== "mcp__forge__forge_pm_set_dependency"),
      mcpServers: { playwright: true },
    },
    approved: { disallowedTools: DENYLIST_FULL },
    developed: { disallowedTools: DENYLIST_FULL },
    testing: {
      disallowedTools: DENYLIST_FULL.filter((t) => t !== "mcp__forge__forge_uploads"),
      mcpServers: { playwright: true },
    },
    reopen: { disallowedTools: DENYLIST_FULL },
    released: { disallowedTools: DENYLIST_FULL },
    tested: { enabled: false },
  },
};

describe("StagePermissionsSection", () => {
  it("humanizes forge MCP tool ids, keeping the raw id reachable via title", () => {
    render(<StagePermissionsSection config={FORGE_DEV_SHAPED} />);
    expandRow("open");
    const chip = screen.getByTitle("mcp__forge__forge_projects_archive");
    expect(chip).toHaveTextContent("Projects archive");
  });

  it("humanizes bare PascalCase builtins", () => {
    render(<StagePermissionsSection config={FORGE_DEV_SHAPED} />);
    expandRow("open");
    expect(screen.getByTitle("CronCreate")).toHaveTextContent("Cron create");
  });

  it("flags exactly testing, clarified, confirmed as outliers for the forge-dev fixture", () => {
    render(<StagePermissionsSection config={FORGE_DEV_SHAPED} />);
    expect(screen.getAllByText("Differs from the other stages")).toHaveLength(3);
  });

  it("labels a per-state mcpServers entry as an override, not the project default", () => {
    render(<StagePermissionsSection config={FORGE_DEV_SHAPED} />);
    expandRow("clarified");
    expect(screen.getAllByText(/overrides the project default/i).length).toBeGreaterThan(0);
  });

  it("renders skipComplexities and sessionGroup where set", () => {
    render(<StagePermissionsSection config={FORGE_DEV_SHAPED} />);
    expect(screen.getByText(/skips xs, s/i)).toBeInTheDocument();
    expect(screen.getByText(/group: planning/i)).toBeInTheDocument();
  });

  it("collapses every row by default — 176-entries-across-9-stages legibility", () => {
    render(<StagePermissionsSection config={FORGE_DEV_SHAPED} />);
    for (const btn of screen.getAllByRole("button")) {
      expect(btn).toHaveAttribute("aria-expanded", "false");
    }
  });

  it("renders the calm empty line when no stage carries an override", () => {
    render(<StagePermissionsSection config={{}} />);
    expect(
      screen.getByText("Every stage runs the default tool surface — no overrides set."),
    ).toBeInTheDocument();
  });
});
