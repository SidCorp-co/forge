// @vitest-environment jsdom
//
// Read-only display (ISS-813) and the edit mode ISS-814 added on top of it.
// Pure component (no query of its own), so the read half is tested with fixture
// configs directly; the edit half mocks only the mutation hook.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StagePermissionsSection } from "./components/stage-permissions-section";
import type { PipelineConfig } from "./types";

expect.extend(matchers);
afterEach(cleanup);

const mutate = vi.fn();
vi.mock("./hooks", async () => {
  const actual = await vi.importActual<typeof import("./hooks")>("./hooks");
  return {
    ...actual,
    useUpdatePipelineConfig: () => ({
      mutate,
      isPending: false,
      isError: false,
      error: null,
      reset: vi.fn(),
    }),
  };
});

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
    open: { disallowedTools: DENYLIST_FULL },
    in_progress: {
      disallowedTools: DENYLIST_FULL.filter((t) => t !== "mcp__forge__forge_pm_set_dependency"),
      mcpServers: { playwright: true },
    },
    needs_info: { disallowedTools: DENYLIST_FULL },
    released: {
      disallowedTools: DENYLIST_FULL.filter((t) => t !== "mcp__forge__forge_uploads"),
    },
  },
};

function renderReadOnly(config: PipelineConfig = FORGE_DEV_SHAPED) {
  return render(
    <StagePermissionsSection projectId="proj-1" config={config} canEdit={false} />,
  );
}

function renderEditable(config: PipelineConfig = FORGE_DEV_SHAPED) {
  return render(<StagePermissionsSection projectId="proj-1" config={config} canEdit />);
}

beforeEach(() => mutate.mockClear());

describe("StagePermissionsSection · read", () => {
  it("humanizes forge MCP tool ids, keeping the raw id reachable via title", () => {
    renderReadOnly();
    expandRow("open");
    const chip = screen.getByTitle("mcp__forge__forge_projects_archive");
    expect(chip).toHaveTextContent("Projects archive");
  });

  it("humanizes bare PascalCase builtins", () => {
    renderReadOnly();
    expandRow("open");
    expect(screen.getByTitle("CronCreate")).toHaveTextContent("Cron create");
  });

  // cm:guard the baseline is the MODAL denylist across the states, so `open` and `needs_info` (which carry it verbatim) must NOT be flagged and the two that drop a tool must. A test that only counted flags would pass on a component that flagged everything.
  it("flags exactly the stages that drift from the modal baseline", () => {
    renderReadOnly();
    expect(screen.getAllByText("Differs from the other stages")).toHaveLength(2);
  });

  it("labels a per-state mcpServers entry as an override, not the project default", () => {
    renderReadOnly();
    expandRow("in_progress");
    expect(screen.getAllByText(/overrides the project default/i).length).toBeGreaterThan(0);
  });

  it("collapses every row by default, so a long denylist stays legible", () => {
    renderReadOnly();
    for (const btn of screen.getAllByRole("button")) {
      expect(btn).toHaveAttribute("aria-expanded", "false");
    }
  });

  it("renders the calm empty line when no stage carries an override", () => {
    renderReadOnly({});
    expect(
      screen.getByText("Every stage runs the default tool surface — no overrides set."),
    ).toBeInTheDocument();
  });

  // cm:guard the whole point of `canEdit=false` is see-everything-change-nothing, so this asserts the chips are STILL THERE and only the write controls are gone — a component that rendered nothing would also pass an assertion that only counted buttons.
  it("shows every value and no write control when canEdit is false", () => {
    renderReadOnly();
    expandRow("open");
    expect(screen.getByTitle("CronCreate")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /remove cron create/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /save .* permissions/i })).toBeNull();
  });
});

describe("StagePermissionsSection · edit", () => {
  it("offers every ladder stage, including ones with no override yet", () => {
    renderEditable({ states: {} });
    for (const status of ["open", "in_progress", "needs_info", "released"]) {
      expect(screen.getByText(status)).toBeInTheDocument();
    }
  });

  it("removing a denied tool sends the stage without it and keeps the rest", () => {
    renderEditable();
    expandRow("open");
    fireEvent.click(screen.getByRole("button", { name: "Remove Cron create" }));
    fireEvent.click(screen.getByRole("button", { name: /save queued permissions/i }));

    const sent = mutate.mock.calls[0]?.[0] as PipelineConfig;
    const states = sent.states as Record<string, Record<string, unknown>>;
    expect(states.open.disallowedTools).toEqual(
      DENYLIST_FULL.filter((t) => t !== "CronCreate"),
    );
  });

  it("adding a typed tool id sends it appended to that stage's denylist", () => {
    renderEditable();
    expandRow("released");
    const field = screen.getByLabelText("Add a tool id to Denied tools");
    fireEvent.change(field, { target: { value: "mcp__forge__forge_memory_write" } });
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: /save awaiting release permissions/i }));

    const sent = mutate.mock.calls[0]?.[0] as PipelineConfig;
    const states = sent.states as Record<string, Record<string, unknown>>;
    expect(states.released.disallowedTools).toContain("mcp__forge__forge_memory_write");
  });

  it("toggling a per-stage MCP server sends it under that stage only", () => {
    renderEditable();
    expandRow("open");
    const row = screen.getByText(/Playwright —/).closest("label") as HTMLElement;
    fireEvent.click(within(row).getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /save queued permissions/i }));

    const sent = mutate.mock.calls[0]?.[0] as PipelineConfig;
    const states = sent.states as Record<string, Record<string, unknown>>;
    expect(states.open.mcpServers).toEqual({ playwright: true });
    expect(states.in_progress.mcpServers).toEqual({ playwright: true });
  });

  // cm:guard an emptied list must go back as `undefined`, not `[]` — `[]` stores a deliberate empty denylist, which reads on every later screen as an override the operator chose rather than a stage with none.
  it("emptying a list clears the key instead of storing an empty array", () => {
    renderEditable({ states: { open: { disallowedTools: ["CronCreate"] } } });
    expandRow("open");
    fireEvent.click(screen.getByRole("button", { name: "Remove Cron create" }));
    fireEvent.click(screen.getByRole("button", { name: /save queued permissions/i }));

    const sent = mutate.mock.calls[0]?.[0] as PipelineConfig;
    const states = sent.states as Record<string, Record<string, unknown>>;
    expect(states.open.disallowedTools).toBeUndefined();
  });

  it("keeps Save disabled until something actually changes", () => {
    renderEditable();
    expandRow("open");
    expect(screen.getByRole("button", { name: /save queued permissions/i })).toBeDisabled();
  });
});
