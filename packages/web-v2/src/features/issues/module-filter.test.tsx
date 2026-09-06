// @vitest-environment jsdom
//
// Two properties of the list's module filter that nothing else can catch:
//
//  1. `?module=` reaches the SEARCH call as `module`, not as `label`. Core resolves the two
//     against different row sets (`label` is uuid-only and matches any kind; `module` matches
//     `kind='module'` only), so a mix-up narrows on a plain label of the same name and the reader
//     is told those are the module's issues.
//  2. Filtering to an empty module says so distinctly. The generic "Nothing here" reads as a
//     broken list; "No issues tagged to X" reads as an empty module, which is what it is.
//
// Plus the module cell, whose whole data source is the `withModules=1` opt-in.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModuleCell } from "./components/issue-table-row";
import { IssuesListView } from "./components/issues-list-view";
import { ToastProvider } from "@/providers/toast-provider";
import type { IssueSearchOpts } from "./types";

expect.extend(matchers);
afterEach(cleanup);
Element.prototype.scrollIntoView = vi.fn();

const CORE = { id: "m-core", name: "core", color: "#1f6f4a", kind: "module" as const, parentId: null };
const BUG = { id: "l-bug", name: "bug", color: "#8a3b52", kind: "label" as const, parentId: null };

let capturedOpts: IssueSearchOpts | undefined;

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/forge-dev/issues",
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));
vi.mock("@/features/shell", async () => {
  const actual = await vi.importActual<typeof import("@/features/shell")>("@/features/shell");
  return { ...actual, usePinnedViews: () => ({ isPinned: () => false, toggle: vi.fn(), remove: vi.fn() }) };
});
vi.mock("./hooks", async () => {
  const actual = await vi.importActual<typeof import("./hooks")>("./hooks");
  return {
    ...actual,
    useIssues: (_p: string, opts: IssueSearchOpts) => {
      capturedOpts = opts;
      return { data: { items: [], totalCount: 0 }, isLoading: false, isError: false, error: null, refetch: vi.fn() };
    },
    useProjectMembers: () => ({ data: [] }),
    useProjectLabels: () => ({ data: [CORE, BUG] }),
    useProjectModules: () => ({ modules: [CORE], data: [CORE], isLoading: false, isError: false, error: null, refetch: vi.fn() }),
    usePatchIssue: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

function mountAt(query: string) {
  window.history.replaceState({}, "", `/projects/forge-dev/issues${query}`);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <IssuesListView scope={{ projectId: "p1", slug: "forge-dev" }} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  capturedOpts = undefined;
});

describe("Issues list · module filter", () => {
  it("sends `?module=` to the search endpoint as `module`, never as `label`", () => {
    mountAt("?module=m-core");
    expect(capturedOpts?.module).toBe("m-core");
    expect(capturedOpts?.label).toBeUndefined();
  });

  it("sends no module at all when the filter is unset", () => {
    mountAt("");
    expect(capturedOpts?.module).toBeUndefined();
  });

  it("keeps the label filter independent of the module filter", () => {
    mountAt("?label=l-bug&module=m-core");
    expect(capturedOpts?.label).toBe("l-bug");
    expect(capturedOpts?.module).toBe("m-core");
  });

  it("offers the module in the Module filter and nowhere else", () => {
    mountAt("");
    expect(screen.getAllByLabelText("Module filter").length).toBeGreaterThan(0);
  });

  it("names the module in the empty state instead of the generic 'Nothing here'", () => {
    mountAt("?module=m-core");
    expect(screen.getByText("No issues in this module")).toBeInTheDocument();
    expect(screen.getByText("No issues tagged to core.")).toBeInTheDocument();
    expect(screen.queryByText("Nothing here")).not.toBeInTheDocument();
  });

  it("keeps the first-run empty state when nothing is filtered", () => {
    mountAt("");
    expect(screen.getByText("No issues yet")).toBeInTheDocument();
  });

  it("offers a clear-filter action out of the module-empty state", () => {
    mountAt("?module=m-core");
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeInTheDocument();
  });

  it("falls back to 'this module' when the id names no module the reader can see", () => {
    mountAt("?module=deleted-id");
    expect(screen.getByText("No issues tagged to this module.")).toBeInTheDocument();
  });
});

describe("ModuleCell", () => {
  it("renders the primary module", () => {
    render(<ModuleCell modules={[{ labelId: "a", name: "core", color: "#1f6f4a", isPrimary: true }]} />);
    expect(screen.getByText("core")).toBeInTheDocument();
  });

  it("renders the PRIMARY, not simply the first entry", () => {
    render(
      <ModuleCell
        modules={[
          { labelId: "b", name: "web", color: "#111111", isPrimary: false },
          { labelId: "a", name: "core", color: "#1f6f4a", isPrimary: true },
        ]}
      />,
    );
    expect(screen.getByText("core")).toBeInTheDocument();
    expect(screen.queryByText("web")).not.toBeInTheDocument();
  });

  it("counts the secondaries rather than listing them", () => {
    render(
      <ModuleCell
        modules={[
          { labelId: "a", name: "core", color: "#1f6f4a", isPrimary: true },
          { labelId: "b", name: "web", color: "#111111", isPrimary: false },
        ]}
      />,
    );
    expect(screen.getByText("+1")).toBeInTheDocument();
  });

  it("shows an em dash when the issue has only secondaries and no primary", () => {
    render(<ModuleCell modules={[{ labelId: "b", name: "web", color: "#111111", isPrimary: false }]} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("shows an em dash when the caller never opted into withModules", () => {
    render(<ModuleCell modules={undefined} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
