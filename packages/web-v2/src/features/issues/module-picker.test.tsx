// @vitest-environment jsdom
//
// The picker's one dangerous property: `PATCH /api/issues/:id` REPLACES the whole
// label set. A payload built from the modules alone silently deletes every plain
// label on the issue, and the server cannot tell that from a deliberate clear —
// so the write is asserted here field by field, not just "a call happened".
//
// The rest is the ux-contract's state set: skeleton, error+retry, and the
// first-run empty that has to say where modules come from.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModulePicker } from "./components/module-picker";
import type { IssueLabel } from "./types";

expect.extend(matchers);
afterEach(cleanup);

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const saveMutate = vi.fn();
let modulesQuery: Record<string, unknown>;

vi.mock("./hooks", async () => {
  const actual = await vi.importActual<typeof import("./hooks")>("./hooks");
  return {
    ...actual,
    useProjectModules: () => modulesQuery,
    useSetIssueModules: () => ({ mutate: saveMutate, isPending: false }),
  };
});

function label(id: string, name: string, kind: "label" | "module", isPrimary = false): IssueLabel {
  return { id, name, color: "#1f6f4a", kind, isPrimary };
}

const CORE = label("m-core", "core", "module");
const WEB = label("m-web", "web", "module");
const BUG = label("l-bug", "bug", "label");

function ready(modules: IssueLabel[]) {
  return {
    modules,
    data: modules,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  };
}

function mount(labels: IssueLabel[]) {
  return render(
    <ModulePicker
      open
      onClose={vi.fn()}
      issueId="i1"
      projectId="p1"
      slug="forge-dev"
      labels={labels}
    />,
  );
}

beforeEach(() => {
  saveMutate.mockReset();
  push.mockReset();
  modulesQuery = ready([CORE, WEB]);
});

describe("ModulePicker · the write", () => {
  it("hands the issue's CURRENT labels to the mutation, so plain labels survive the replace", () => {
    mount([BUG, { ...CORE, isPrimary: true }]);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(saveMutate).toHaveBeenCalledWith(
      { current: [BUG, { ...CORE, isPrimary: true }], moduleIds: ["m-core"], primaryId: "m-core" },
      expect.anything(),
    );
  });

  it("marks exactly the chosen radio as primary", () => {
    mount([]);
    fireEvent.click(screen.getByRole("radio", { name: "web" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(saveMutate.mock.calls[0][0]).toMatchObject({ primaryId: "m-web", moduleIds: ["m-web"] });
  });

  it("selects a module implicitly when it is made primary", () => {
    mount([]);
    fireEvent.click(screen.getByRole("radio", { name: "core" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(saveMutate.mock.calls[0][0].moduleIds).toContain("m-core");
  });

  it("carries a secondary alongside the primary", () => {
    mount([]);
    fireEvent.click(screen.getByRole("radio", { name: "core" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "web" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const { moduleIds, primaryId } = saveMutate.mock.calls[0][0];
    expect(primaryId).toBe("m-core");
    expect([...moduleIds].sort()).toEqual(["m-core", "m-web"]);
  });

  it("sends primaryId null when 'No primary module' is chosen, not an empty string", () => {
    mount([{ ...CORE, isPrimary: true }]);
    fireEvent.click(screen.getByRole("radio", { name: "No primary module" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(saveMutate.mock.calls[0][0].primaryId).toBeNull();
  });

  it("clears the primary when its own checkbox is un-ticked, rather than promoting a secondary", () => {
    mount([{ ...CORE, isPrimary: true }, WEB]);
    fireEvent.click(screen.getByRole("radio", { name: "No primary module" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "core" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const { moduleIds, primaryId } = saveMutate.mock.calls[0][0];
    expect(primaryId).toBeNull();
    expect(moduleIds).toEqual(["m-web"]);
  });

  it("seeds from the issue's existing attributions", () => {
    mount([{ ...WEB, isPrimary: true }, CORE]);
    expect(screen.getByRole("radio", { name: "web" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("checkbox", { name: "core" })).toHaveAttribute("aria-checked", "true");
  });
});

describe("ModulePicker · states", () => {
  it("renders a skeleton while the taxonomy loads", () => {
    modulesQuery = { modules: [], data: undefined, isLoading: true, isError: false, error: null, refetch: vi.fn() };
    const { container } = mount([]);
    expect(container.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
  });

  it("renders a retryable error, never a blank drawer", () => {
    const refetch = vi.fn();
    modulesQuery = { modules: [], data: undefined, isLoading: false, isError: true, error: new Error("down"), refetch };
    mount([]);
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalled();
  });

  it("tells a project with no modules where to make one, and goes there", () => {
    modulesQuery = ready([]);
    mount([]);
    expect(
      screen.getByText("No modules defined — add modules in project settings."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open project settings" }));
    expect(push).toHaveBeenCalledWith("/projects/forge-dev/settings?tab=modules");
  });

  it("offers no Save when there is nothing to attribute to", () => {
    modulesQuery = ready([]);
    mount([]);
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });
});
