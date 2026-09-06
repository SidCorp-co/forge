// @vitest-environment jsdom
//
// ISS-814 — `agentConfig.stateContext` editing, reached through the scoped
// `stateContext` field on PATCH /api/projects/:id. Mocks useProject the same
// way rocketchat-section relies on it for agentConfig.*, and the mutation hook
// so what the component would SEND is what gets asserted.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentConfigSection } from "./components/agent-config-section";
import type { StateContextEntry } from "./types";

expect.extend(matchers);
afterEach(cleanup);

// cm:why Select scrolls its active option into view and jsdom has no scrollIntoView, so opening the jobType picker throws without this stub
Element.prototype.scrollIntoView = vi.fn();

const useProject = vi.fn();
vi.mock("@/features/projects/hooks", () => ({
  useProject: (...args: unknown[]) => useProject(...args),
}));

const mutate = vi.fn();
vi.mock("./hooks", async () => {
  const actual = await vi.importActual<typeof import("./hooks")>("./hooks");
  return {
    ...actual,
    useUpdateStateContext: () => ({ mutate, isPending: false }),
  };
});

function loaded(agentConfig: Record<string, unknown>) {
  useProject.mockReturnValue({
    isLoading: false,
    isError: false,
    data: { agentConfig },
    refetch: vi.fn(),
  });
}

const sent = () => mutate.mock.calls[0]?.[0] as Record<string, StateContextEntry | null>;

beforeEach(() => mutate.mockClear());

describe("AgentConfigSection · states", () => {
  it("renders a Skeleton while the project is loading", () => {
    useProject.mockReturnValue({ isLoading: true, isError: false, data: undefined, refetch: vi.fn() });
    render(<AgentConfigSection projectId="proj-1" canEdit />);
    expect(document.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
  });

  it("renders ErrorState with Retry on fetch failure", () => {
    useProject.mockReturnValue({
      isLoading: false,
      isError: true,
      error: new Error("network down"),
      data: undefined,
      refetch: vi.fn(),
    });
    render(<AgentConfigSection projectId="proj-1" canEdit />);
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("offers the add control from the empty state rather than a blank block", () => {
    loaded({});
    render(<AgentConfigSection projectId="proj-1" canEdit />);
    expect(screen.getByText("No per-job context")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add triage/i })).toBeInTheDocument();
  });

  it("offers no add control from the empty state when canEdit is false", () => {
    loaded({});
    render(<AgentConfigSection projectId="proj-1" canEdit={false} />);
    expect(screen.getByText("No per-job context")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add triage/i })).toBeNull();
  });
});

describe("AgentConfigSection · editing", () => {
  it("sends a changed modelOverride under its jobType", () => {
    loaded({ stateContext: { code: { modelOverride: "claude-opus-5" } } });
    render(<AgentConfigSection projectId="proj-1" canEdit />);
    fireEvent.change(screen.getByLabelText("Model override"), {
      target: { value: "claude-sonnet-5" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save per-job context/i }));
    expect(sent().code).toEqual({ modelOverride: "claude-sonnet-5" });
  });

  // cm:guard the server REPLACES a jobType's entry whole, so a patch built from the two fields this form draws would delete `blocks` and every key a later schema adds. Delete the `...entry` spread in `onPatch` and this is what goes red.
  it("preserves keys of the entry the form does not draw", () => {
    loaded({
      stateContext: {
        code: { modelOverride: "claude-opus-5", blocks: { a: 1 }, futureKnob: "keep" },
      },
    });
    render(<AgentConfigSection projectId="proj-1" canEdit />);
    fireEvent.change(screen.getByLabelText("Model override"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /save per-job context/i }));
    expect(sent().code).toEqual({
      modelOverride: "x",
      blocks: { a: 1 },
      futureKnob: "keep",
    });
  });

  // cm:guard core's `budgetSchema` is `.strict()` with all three keys REQUIRED, so a half-filled budget is a 400, not a smaller budget. Save must refuse it here rather than learn that from the server.
  it("blocks Save on a budget missing one of its three keys", () => {
    loaded({ stateContext: { code: { budget: { perRunUsd: 5 } } } });
    render(<AgentConfigSection projectId="proj-1" canEdit />);
    expect(
      screen.getByText("A budget needs all three of per-run, per-month and action."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save per-job context/i })).toBeDisabled();
  });

  it("blocks Save on a per-run value above the cap core would reject", () => {
    loaded({
      stateContext: { code: { budget: { perRunUsd: 5000, perMonthUsd: 10, action: "warn" } } },
    });
    render(<AgentConfigSection projectId="proj-1" canEdit />);
    expect(screen.getByText(/Per-run must be between 0 and 1000/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save per-job context/i })).toBeDisabled();
  });

  // cm:guard ticking the cap must NOT seed zeros — a `perRunUsd: 0` saved unedited caps this job type at nothing, which is a dispatch block the operator never asked for. Save stays held until real numbers replace the blank.
  it("ticking the spend cap seeds no amounts and holds Save until they are typed", () => {
    loaded({ stateContext: { code: {} } });
    render(<AgentConfigSection projectId="proj-1" canEdit />);
    fireEvent.click(screen.getByRole("checkbox", { name: /cap spend for this job type/i }));
    expect(screen.getByLabelText("Per run (USD)")).toHaveValue(null);
    expect(screen.getByRole("button", { name: /save per-job context/i })).toBeDisabled();
  });

  it("accepts a complete budget and sends it whole", () => {
    loaded({
      stateContext: { code: { budget: { perRunUsd: 5, perMonthUsd: 100, action: "warn" } } },
    });
    render(<AgentConfigSection projectId="proj-1" canEdit />);
    fireEvent.change(screen.getByLabelText("Per run (USD)"), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: /save per-job context/i }));
    expect(sent().code?.budget).toEqual({ perRunUsd: 7, perMonthUsd: 100, action: "warn" });
  });

  // cm:guard removal is an explicit `null`, not an omission — the server merges per key, so a patch that simply leaves the jobType out keeps the stored entry and the screen then disagrees with the database.
  it("sends null for a removed jobType, and leaves the others alone", () => {
    loaded({
      stateContext: {
        code: { modelOverride: "claude-opus-5" },
        review: { modelOverride: "claude-sonnet-5" },
      },
    });
    render(<AgentConfigSection projectId="proj-1" canEdit />);
    const codeRow = screen.getByText("code").closest("li") as HTMLElement;
    fireEvent.click(within(codeRow).getByRole("button", { name: /remove/i }));
    fireEvent.click(screen.getByRole("button", { name: /save per-job context/i }));
    expect(sent()).toEqual({ code: null, review: { modelOverride: "claude-sonnet-5" } });
  });

  it("adds a jobType that has no entry yet", () => {
    loaded({ stateContext: { code: {} } });
    render(<AgentConfigSection projectId="proj-1" canEdit />);
    fireEvent.click(screen.getByRole("combobox", { name: /add a job type/i }));
    fireEvent.click(screen.getByRole("option", { name: "drive" }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: /save per-job context/i }));
    expect(Object.keys(sent())).toEqual(["code", "drive"]);
  });

  it("shows every value and no write control when canEdit is false", () => {
    loaded({ stateContext: { code: { modelOverride: "claude-opus-5" } } });
    render(<AgentConfigSection projectId="proj-1" canEdit={false} />);
    expect(screen.getByLabelText("Model override")).toHaveValue("claude-opus-5");
    expect(screen.getByLabelText("Model override")).toBeDisabled();
    expect(screen.queryByRole("button", { name: /save per-job context/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^remove$/i })).toBeNull();
  });
});
