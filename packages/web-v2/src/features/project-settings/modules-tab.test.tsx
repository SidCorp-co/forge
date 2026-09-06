// @vitest-environment jsdom
//
// The Modules tab is the ONLY screen that can edit a module's parent, so its
// two derivations carry the taxonomy's shape and have to be right on their own:
//
//  1. `flattenModules` must render every module exactly once, children under
//     their parent, and must not lose one whose parent is gone — that row is
//     otherwise unreachable and unrepairable.
//  2. `descendantIds` decides which parents a row may offer. Offering a
//     descendant is offering a choice the server can only answer with
//     CIRCULAR_HIERARCHY.
//
// Plus the states the ux-contract binds: loading, error+retry, first-run empty,
// destructive confirm before any delete request, and read-only for a viewer.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ModulesTab,
  descendantIds,
  flattenModules,
} from "./components/modules-tab";
import type { ProjectLabel } from "./types";

expect.extend(matchers);
afterEach(cleanup);

// cm:why Select scrolls its active option into view and jsdom has no scrollIntoView, so opening the parent picker throws without this stub
Element.prototype.scrollIntoView = vi.fn();

function mod(id: string, name: string, parentId: string | null = null): ProjectLabel {
  return { id, name, color: "#1f6f4a", kind: "module", parentId, description: null };
}

const createMutate = vi.fn();
const updateMutate = vi.fn();
const deleteMutate = vi.fn();
let labelsQuery: Record<string, unknown>;

vi.mock("./hooks", async () => {
  const actual = await vi.importActual<typeof import("./hooks")>("./hooks");
  return {
    ...actual,
    useLabels: () => labelsQuery,
    useCreateLabel: () => ({ mutate: createMutate, isPending: false }),
    useUpdateLabel: () => ({ mutate: updateMutate, isPending: false }),
    useDeleteLabel: () => ({ mutate: deleteMutate, isPending: false }),
  };
});

beforeEach(() => {
  createMutate.mockReset();
  updateMutate.mockReset();
  deleteMutate.mockReset();
  labelsQuery = { data: [], isLoading: false, isError: false, error: null, refetch: vi.fn() };
});

describe("flattenModules", () => {
  it("nests a child under its parent and indents it one level", () => {
    const tree = flattenModules([mod("c", "core"), mod("w", "web", "c")]);
    expect(tree.map((n) => [n.module.name, n.depth])).toEqual([
      ["core", 0],
      ["web", 1],
    ]);
  });

  it("sorts alphabetically within a level, not across levels", () => {
    const tree = flattenModules([
      mod("b", "beta"),
      mod("a", "alpha"),
      mod("z", "zeta", "a"),
    ]);
    expect(tree.map((n) => n.module.name)).toEqual(["alpha", "zeta", "beta"]);
  });

  it("keeps a module whose parent is missing, at the root rather than dropping it", () => {
    const tree = flattenModules([mod("orphan", "orphan", "deleted-id")]);
    expect(tree.map((n) => [n.module.name, n.depth])).toEqual([["orphan", 0]]);
  });

  it("terminates on a cycle instead of recursing forever", () => {
    const tree = flattenModules([mod("a", "a", "b"), mod("b", "b", "a")]);
    expect(tree).toHaveLength(0);
  });
});

describe("descendantIds", () => {
  it("includes the module itself", () => {
    expect(descendantIds([mod("a", "a")], "a")).toEqual(new Set(["a"]));
  });

  it("includes a grandchild, so a two-level cycle cannot be offered", () => {
    const all = [mod("a", "a"), mod("b", "b", "a"), mod("c", "c", "b")];
    expect(descendantIds(all, "a")).toEqual(new Set(["a", "b", "c"]));
  });

  it("excludes a sibling, which is a legal parent", () => {
    const all = [mod("a", "a"), mod("b", "b")];
    expect(descendantIds(all, "a").has("b")).toBe(false);
  });
});

describe("ModulesTab · states", () => {
  it("renders a skeleton while the taxonomy loads", () => {
    labelsQuery = { data: undefined, isLoading: true, isError: false, error: null, refetch: vi.fn() };
    const { container } = render(<ModulesTab projectId="p" canEdit />);
    expect(container.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
  });

  it("renders a retryable error rather than an empty list", () => {
    const refetch = vi.fn();
    labelsQuery = { data: undefined, isLoading: false, isError: true, error: new Error("nope"), refetch };
    render(<ModulesTab projectId="p" canEdit />);
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalled();
  });

  it("offers a first-run empty state when the project has no module", () => {
    render(<ModulesTab projectId="p" canEdit />);
    expect(screen.getByText("No modules yet")).toBeInTheDocument();
  });

  it("does not count a plain label as a module", () => {
    labelsQuery = {
      data: [{ id: "l", name: "bug", color: "#111111", kind: "label", parentId: null, description: null }],
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    };
    render(<ModulesTab projectId="p" canEdit />);
    expect(screen.getByText("No modules yet")).toBeInTheDocument();
    expect(screen.queryByText("bug")).not.toBeInTheDocument();
  });
});

describe("ModulesTab · editing", () => {
  beforeEach(() => {
    labelsQuery = {
      data: [mod("c", "core"), mod("w", "web", "c")],
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    };
  });

  it("creates a module with kind 'module' and no colour, letting the server derive one", () => {
    render(<ModulesTab projectId="p" canEdit />);
    fireEvent.change(screen.getByLabelText("New module name"), { target: { value: " runner " } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(createMutate).toHaveBeenCalledWith(
      { name: "runner", kind: "module" },
      expect.anything(),
    );
  });

  it("re-parents through the row's parent control", () => {
    render(<ModulesTab projectId="p" canEdit />);
    const select = screen.getByLabelText("Parent of web");
    fireEvent.click(select);
    fireEvent.click(screen.getByRole("option", { name: "No parent" }));
    expect(updateMutate).toHaveBeenCalledWith({ labelId: "w", patch: { parentId: null } });
  });

  it("never offers a module its own descendant as a parent", () => {
    render(<ModulesTab projectId="p" canEdit />);
    fireEvent.click(screen.getByLabelText("Parent of core"));
    expect(screen.queryByRole("option", { name: "web" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "core" })).not.toBeInTheDocument();
  });

  it("renames on blur and sends the trimmed name", () => {
    render(<ModulesTab projectId="p" canEdit />);
    const input = screen.getByLabelText("Module name for core");
    fireEvent.change(input, { target: { value: "  kernel  " } });
    fireEvent.blur(input);
    expect(updateMutate).toHaveBeenCalledWith({ labelId: "c", patch: { name: "kernel" } });
  });

  it("sends nothing when a rename is blurred unchanged", () => {
    render(<ModulesTab projectId="p" canEdit />);
    fireEvent.blur(screen.getByLabelText("Module name for core"));
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it("asks for confirmation before it deletes anything", () => {
    render(<ModulesTab projectId="p" canEdit />);
    fireEvent.click(screen.getByLabelText("Delete module core"));
    expect(deleteMutate).not.toHaveBeenCalled();
    expect(screen.getByText("Delete module")).toBeInTheDocument();
  });

  it("deletes only after the confirm is taken", () => {
    render(<ModulesTab projectId="p" canEdit />);
    fireEvent.click(screen.getByLabelText("Delete module core"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(deleteMutate).toHaveBeenCalledWith("c", expect.anything());
  });

  it("gives a viewer no write control at all", () => {
    render(<ModulesTab projectId="p" canEdit={false} />);
    expect(screen.getByText("core")).toBeInTheDocument();
    expect(screen.queryByLabelText("Delete module core")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Parent of core")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add" })).not.toBeInTheDocument();
  });
});
