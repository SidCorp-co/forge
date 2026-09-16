// @vitest-environment jsdom
//
// ISS-1038 criterion 21 — the per-stage MCP editor used to render a stored
// integration sentinel as a bare name with a Remove button beside it and
// nothing saying what it was. Remove stays: a stage-scoped sentinel has no
// control anywhere else in the product, and taking it away would be this
// issue's own defect pointed the other way. What it gains is a label, and a
// sentence naming where the project-wide switch is.
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PipelineConfig } from "../types";
import { StagePermissionsSection } from "./stage-permissions-section";

expect.extend(matchers);

vi.mock("../hooks", () => ({
  useUpdatePipelineConfig: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
    reset: vi.fn(),
  }),
}));

afterEach(cleanup);

function renderStages(stageMcp: Record<string, unknown>) {
  const config = {
    mcpServers: {},
    states: { in_progress: { mcpServers: stageMcp } },
  } as unknown as PipelineConfig;
  render(<StagePermissionsSection projectId="p-1" config={config} canEdit />);
  // The rows are collapsed by default — open the one under test.
  fireEvent.click(screen.getByText("Running"));
}

describe("StagePermissionsSection integration sentinels (ISS-1038)", () => {
  it("says a `true` sentinel IS injected at this stage", () => {
    renderStages({ epodsystem: true });
    expect(screen.getByText("epodsystem")).toBeTruthy();
    expect(screen.getByText(/Epodsystem · injected at this stage/)).toBeTruthy();
  });

  it("says a `false` entry is NOT injected at this stage", () => {
    // The state this change made effective at dispatch. Labelling it the same
    // as a `true` would leave the screen stating the opposite of what a job at
    // this stage gets — which is the defect this whole issue is about, one
    // level down.
    renderStages({ epodsystem: false });
    expect(screen.getByText("epodsystem")).toBeTruthy();
    expect(screen.getByText(/Epodsystem · NOT injected at this stage/)).toBeTruthy();
  });

  it("says an object value under an integration name carries no credential", () => {
    renderStages({ sentry: { type: "stdio", command: "npx" } });
    expect(screen.getByText(/Sentry · custom spec, no credential attached/)).toBeTruthy();
  });

  it("labels a labelled epodsystem_<label> sentinel too", () => {
    renderStages({ epodsystem_store_a: true });
    expect(screen.getByText("epodsystem_store_a")).toBeTruthy();
    expect(screen.getByText(/Epodsystem · injected at this stage/)).toBeTruthy();
  });

  it("names where the project-wide switch lives", () => {
    renderStages({ sentry: true });
    expect(document.body.textContent).toMatch(
      /switched for the whole project on Settings → Integrations → Agent MCP servers/,
    );
  });

  it("keeps Remove on an integration entry", () => {
    renderStages({ epodsystem: true });
    expect(screen.getAllByText("Remove").length).toBeGreaterThan(0);
  });

  it("does not label a genuine custom server as an integration", () => {
    renderStages({ mything: { type: "stdio" } });
    expect(screen.getByText("mything")).toBeTruthy();
    expect(screen.queryByText(/injected at this stage/)).toBeNull();
  });
});
