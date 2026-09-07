// @vitest-environment jsdom
//
// ISS-949 — the Modules view's states and the two properties the counts rest on:
//
//  1. primary and secondary are rendered as separate lines and never added together, and each
//     says how much of it is the module's own and how much is inherited;
//  2. the issues with no module are a row of their own, never folded into a module.
//
// Plus the four states the ux-contract owes a searchable surface: loading, first-run empty,
// filtered empty (distinct from it) and error with a working retry.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModuleRollupView } from "./components/module-rollup-view";
import type { ModuleCounts, ModuleRollupResponse, ModuleRollupRow } from "./types";

expect.extend(matchers);
afterEach(cleanup);

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

const counts = (over: Partial<ModuleCounts> = {}): ModuleCounts => ({
  total: 0,
  open: 0,
  closed: 0,
  recentlyActive: 0,
  ...over,
});

const moduleRow = (over: Partial<ModuleRollupRow> = {}): ModuleRollupRow => ({
  id: "m-core",
  name: "core",
  slug: "core",
  color: "#1f6f4a",
  parentId: null,
  depth: 0,
  own: { primary: counts(), secondary: counts() },
  inherited: { primary: counts(), secondary: counts() },
  rollup: { primary: counts(), secondary: counts() },
  ...over,
});

let rollupState: {
  data?: ModuleRollupResponse;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
};
const refetch = vi.fn();

vi.mock("./hooks", async () => {
  const actual = await vi.importActual<typeof import("./hooks")>("./hooks");
  return { ...actual, useModuleRollup: () => ({ ...rollupState, refetch }) };
});

function mount(state: typeof rollupState) {
  rollupState = state;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ModuleRollupView scope={{ projectId: "p1", slug: "forge-dev" }} />
    </QueryClientProvider>,
  );
}

const loaded = (over: Partial<ModuleRollupResponse> = {}) => ({
  data: {
    activeWithinDays: 30,
    generatedAt: "2026-09-07T00:00:00.000Z",
    modules: [moduleRow()],
    unassigned: counts(),
    ...over,
  },
  isLoading: false,
  isError: false,
  error: null,
});

describe("ISS-949 · the states the ux-contract owes", () => {
  it("shows a busy region while the rollup is in flight", () => {
    mount({ isLoading: true, isError: false, error: null });
    expect(screen.getByLabelText("Modules")).toHaveAttribute("aria-busy", "true");
  });

  it("shows the first-run empty state when the project has no modules", () => {
    mount(loaded({ modules: [] }));
    expect(screen.getByText("No modules yet")).toBeInTheDocument();
  });

  it("shows a DISTINCT filtered-empty state, with a way to clear the search", () => {
    mount(loaded());
    fireEvent.change(screen.getByLabelText("Search modules"), { target: { value: "zzz" } });

    expect(screen.queryByText("No modules yet")).not.toBeInTheDocument();
    expect(screen.getByText('No modules match "zzz"')).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByText("core")).toBeInTheDocument();
  });

  it("shows the error state with a retry that refetches", () => {
    mount({ isLoading: false, isError: true, error: new Error("boom") });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
  });
});

describe("ISS-949 · what the rows say", () => {
  it("renders primary and secondary as separate lines, never summed", () => {
    mount(
      loaded({
        modules: [
          moduleRow({
            own: { primary: counts({ total: 3 }), secondary: counts({ total: 2 }) },
            inherited: { primary: counts({ total: 1 }), secondary: counts() },
            rollup: { primary: counts({ total: 4 }), secondary: counts({ total: 2 }) },
          }),
        ],
      }),
    );

    const primary = screen.getByText("Primary").parentElement as HTMLElement;
    expect(primary.textContent).toContain("4 total");
    expect(primary.textContent).toContain("(3 own, 1 inherited)");

    const secondary = screen.getByText("Secondary").parentElement as HTMLElement;
    expect(secondary.textContent).toContain("2 total");
    expect(secondary.textContent).toContain("(2 own, 0 inherited)");
  });

  it("gives the issues with no module a row of their own", () => {
    mount(loaded({ unassigned: counts({ total: 7, open: 5, closed: 2 }) }));
    const bucket = screen.getByText("No module").parentElement as HTMLElement;
    expect(bucket.textContent).toContain("7 total");
  });

  it("links a module to the issue list filtered to it", () => {
    mount(loaded());
    expect(screen.getByRole("link", { name: "core" })).toHaveAttribute(
      "href",
      "/projects/forge-dev/issues?tab=list&module=m-core",
    );
  });

  it("indents a child module under its parent", () => {
    mount(
      loaded({
        modules: [moduleRow(), moduleRow({ id: "m-api", name: "api", depth: 2 })],
      }),
    );
    const child = screen.getByRole("link", { name: "api" }).closest("li") as HTMLElement;
    expect(child.style.marginLeft).toBe("32px");
  });
});
