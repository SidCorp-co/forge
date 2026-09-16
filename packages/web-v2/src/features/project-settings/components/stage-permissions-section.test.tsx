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
    expect(screen.getByText(/Epodsystem · this declaration is on/)).toBeTruthy();
  });

  it("says a `false` entry is off, without claiming the provider is not injected", () => {
    // The state this change made effective at dispatch. Labelling it the same
    // as a `true` would state the opposite of what a job at this stage gets —
    // and claiming the PROVIDER is not injected would be wrong the other way,
    // because another matching key can still be `true`.
    renderStages({ epodsystem: false });
    expect(screen.getByText("epodsystem")).toBeTruthy();
    expect(screen.getByText(/Epodsystem · this declaration is off/)).toBeTruthy();
  });

  it("says an object value under an integration name carries no credential", () => {
    renderStages({ sentry: { type: "stdio", command: "npx" } });
    expect(screen.getByText(/Sentry · custom spec, no credential attached/)).toBeTruthy();
  });

  it("labels a labelled epodsystem_<label> sentinel too", () => {
    renderStages({ epodsystem_store_a: true });
    expect(screen.getByText("epodsystem_store_a")).toBeTruthy();
    expect(screen.getByText(/Epodsystem · this declaration is on/)).toBeTruthy();
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
    expect(screen.queryByText(/this declaration is/)).toBeNull();
  });
});

describe("StagePermissionsSection scope honesty (ISS-1038 review F4/F5)", () => {
  function renderWith(
    projectDefault: Record<string, unknown>,
    stageMcp: Record<string, unknown>,
    canEdit = true,
  ) {
    const config = {
      mcpServers: projectDefault,
      states: { in_progress: { mcpServers: stageMcp } },
    } as unknown as PipelineConfig;
    render(<StagePermissionsSection projectId="p-1" config={config} canEdit={canEdit} />);
    fireEvent.click(screen.getByText("Running"));
  }

  it("a label `false` under an inherited bare sentinel does not claim the provider is off", () => {
    // `resolveJobMcpServers` still injects here: the bare `epodsystem: true`
    // survives the stage's `epodsystem_store: false`. A row saying Epodsystem
    // is not injected at this stage would be the screen contradicting dispatch.
    renderWith({ epodsystem: true }, { epodsystem_store: false });
    expect(document.body.textContent).not.toMatch(/not injected/i);
    expect(screen.getByText(/this declaration is off/)).toBeTruthy();
  });

  it("a stage holding one matching true beside one matching false says so per entry", () => {
    renderWith({}, { epodsystem_a: true, epodsystem_b: false });
    expect(screen.getByText(/epodsystem_a/)).toBeTruthy();
    expect(screen.getByText(/epodsystem_b/)).toBeTruthy();
    expect(screen.getByText(/this declaration is on/)).toBeTruthy();
    expect(screen.getByText(/this declaration is off/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/not injected/i);
  });

  it("the READ-ONLY view labels true, false and a custom spec differently", () => {
    renderWith({}, { epodsystem: true, postman: false, sentry: { type: "stdio" } }, false);
    expect(screen.getByText(/Epodsystem · this declaration is on/)).toBeTruthy();
    expect(screen.getByText(/Postman · this declaration is off/)).toBeTruthy();
    expect(screen.getByText(/Sentry · custom spec, no credential attached/)).toBeTruthy();
  });
});
