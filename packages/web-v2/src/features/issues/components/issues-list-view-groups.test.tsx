// @vitest-environment jsdom
//
// ISS-1154 — what the list owns now that the Issues screen has no tabs:
//
//  • the release gate panel stands above the list under the Awaiting release filter, and nowhere else;
//  • Group: module files each issue under its primary module, and each header carries the rows of it
//    on this page beside the project's counts from the module rollup — or says it cannot, rather
//    than printing a zero for a read that failed.

import { ApiError } from "@/lib/api/client";
import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/providers/toast-provider";
import { IssuesListView } from "./issues-list-view";
import type { IssueRow, ModuleCounts, ModuleRollupResponse, ModuleRollupRow } from "../types";

expect.extend(matchers);
afterEach(cleanup);
Element.prototype.scrollIntoView = vi.fn();

const counts = (over: Partial<ModuleCounts> = {}): ModuleCounts => ({
  total: 0,
  open: 0,
  closed: 0,
  recentlyActive: 0,
  ...over,
});

const moduleRow = (id: string, name: string, primary: Partial<ModuleCounts>, secondary = counts()): ModuleRollupRow => ({
  id,
  name,
  slug: name,
  color: "#1f6f4a",
  parentId: null,
  depth: 0,
  own: { primary: counts(primary), secondary },
  inherited: { primary: counts(), secondary: counts() },
  rollup: { primary: counts(primary), secondary },
});

const mod = (labelId: string, name: string, isPrimary = true) => ({ labelId, name, color: "#000000", isPrimary });

const issue = (n: number, modules: IssueRow["modules"]): IssueRow => ({
  id: `i${n}`,
  projectId: "p1",
  issSeq: n,
  displayId: `ISS-${n}`,
  title: `Issue number ${n}`,
  status: "open",
  priority: "medium",
  category: null,
  complexity: null,
  assigneeId: null,
  createdById: "u1",
  creatorEmail: "ann@x.co",
  creatorIsAgent: false,
  creatorLabel: "Ann Lee",
  reopenCount: 0,
  mergedAt: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  statusEnteredAt: "2026-09-01T00:00:00.000Z",
  modules,
});

const ITEMS: IssueRow[] = [
  issue(1, [mod("m-web", "web"), mod("m-core", "core", false)]),
  issue(2, [mod("m-core", "core")]),
  issue(3, []),
  issue(4, [mod("m-web", "web")]),
];

let rollup: { data?: ModuleRollupResponse; isLoading: boolean; isError: boolean; error: unknown };
let rollupAskedFor: (string | undefined)[] = [];
const rollupRefetch = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/forge-dev/issues",
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));
vi.mock("@/features/shell", async () => {
  const actual = await vi.importActual<typeof import("@/features/shell")>("@/features/shell");
  return { ...actual, usePinnedViews: () => ({ isPinned: () => false, toggle: vi.fn(), remove: vi.fn() }) };
});
vi.mock("./release-gate-panel", () => ({ ReleaseGatePanel: () => <div data-testid="release-gate-panel" /> }));
vi.mock("../hooks", async () => {
  const actual = await vi.importActual<typeof import("../hooks")>("../hooks");
  return {
    ...actual,
    useIssues: () => ({
      data: { items: ITEMS, totalCount: ITEMS.length },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }),
    useModuleRollup: (projectId: string | undefined) => {
      rollupAskedFor.push(projectId);
      return { ...rollup, refetch: rollupRefetch };
    },
    useProjectMembers: () => ({ data: [] }),
    useProjectLabels: () => ({ data: [] }),
    useProjectModules: () => ({ modules: [], data: [], isLoading: false, isError: false, error: null, refetch: vi.fn() }),
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

const READ: typeof rollup = {
  data: {
    activeWithinDays: 30,
    generatedAt: "2026-09-07T00:00:00.000Z",
    modules: [
      moduleRow("m-core", "core", { total: 140, open: 12 }, counts({ total: 9 })),
      moduleRow("m-web", "web", { total: 61, open: 4 }),
    ],
    unassigned: counts({ total: 33, open: 5 }),
  },
  isLoading: false,
  isError: false,
  error: null,
};

beforeEach(() => {
  rollup = READ;
  rollupAskedFor = [];
});

describe("the release gate panel", () => {
  it("stands above the list under the Awaiting release filter", () => {
    mountAt("?filter=awaiting_release");
    expect(screen.getByTestId("release-gate-panel")).toBeInTheDocument();
  });

  it.each(["", "?filter=in_flight", "?filter=finished", "?groupBy=module"])(
    "is not rendered at %j",
    (query) => {
      mountAt(query);
      expect(screen.queryByTestId("release-gate-panel")).toBeNull();
    },
  );
});

describe("Group: module", () => {
  const headings = () => screen.getAllByTestId("module-group-counts").map((n) => n.textContent);

  it("is offered in the Group by select, and choosing it groups the list by module", () => {
    mountAt("");
    fireEvent.click(screen.getAllByLabelText("Group by")[0]);
    fireEvent.click(screen.getByRole("option", { name: "Group: module" }));
    expect(new URLSearchParams(window.location.search).get("groupBy")).toBe("module");
  });

  it("is offered in the mobile Filters sheet as well", () => {
    mountAt("");
    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    const sheet = screen.getByRole("dialog");
    fireEvent.click(within(sheet).getByLabelText("Group by"));
    expect(screen.getByRole("option", { name: "Group: module" })).toBeInTheDocument();
  });

  it("files each issue once under its primary module, the issues with none under No module", () => {
    mountAt("?groupBy=module");
    // One list draws every group once, at every width.
    expect(screen.getAllByText(/^core · 1 on this page$/)).toHaveLength(1);
    expect(screen.getAllByText(/^web · 2 on this page$/)).toHaveLength(1);
    expect(screen.getAllByText(/^No module · 1 on this page$/)).toHaveLength(1);
  });

  it("prints the rollup's primary total and open count for a module, and its secondary tagging apart", () => {
    mountAt("?groupBy=module");
    expect(headings()).toContain("140 in the project · 12 open · also tagged on 9");
    expect(headings()).toContain("61 in the project · 4 open");
  });

  it("prints the rollup's unassigned counts under No module", () => {
    mountAt("?groupBy=module");
    expect(headings()).toContain("33 in the project · 5 open");
  });

  it("says the project counts could not be read, and why, never a zero", () => {
    rollup = { data: undefined, isLoading: false, isError: true, error: new ApiError(503, "Service Unavailable") };
    mountAt("?groupBy=module");
    expect(headings().every((t) => /^Project counts could not be read\. \S/.test(t))).toBe(true);
    expect(screen.queryByText(/in the project/)).toBeNull();
  });

  // ISS-1228 round 23 (master's read of the r23 after-shots): a failed read said to try again with no Retry.
  it("offers Retry beside counts the server refused, and refetches the rollup", () => {
    rollup = { data: undefined, isLoading: false, isError: true, error: new ApiError(409, "Try again in a minute.", "X") };
    mountAt("?groupBy=module");
    const retries = screen.getAllByRole("button", { name: "Retry" });
    expect(retries.length).toBeGreaterThan(0);
    fireEvent.click(retries[0] as HTMLElement);
    expect(rollupRefetch).toHaveBeenCalled();
  });

  it("offers no Retry beside counts Forge answered 401 for", () => {
    rollup = { data: undefined, isLoading: false, isError: true, error: new ApiError(401, "Unauthenticated", "UNAUTHENTICATED") };
    mountAt("?groupBy=module");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("says so for a module the rollup does not hold", () => {
    const only: ModuleRollupResponse = {
      activeWithinDays: 30,
      generatedAt: "2026-09-07T00:00:00.000Z",
      modules: [moduleRow("m-web", "web", { total: 61, open: 4 })],
      unassigned: counts(),
    };
    rollup = { data: only, isLoading: false, isError: false, error: null };
    mountAt("?groupBy=module");
    expect(headings()).toContain("Project counts unavailable");
    expect(headings()).toContain("61 in the project · 4 open");
  });

  it("reads the rollup only while grouped by module", () => {
    mountAt("?groupBy=status");
    expect(rollupAskedFor.every((p) => p === undefined)).toBe(true);
    cleanup();
    rollupAskedFor = [];
    mountAt("?groupBy=module");
    expect(rollupAskedFor).toContain("p1");
  });

  it("narrows to a module from its header, replacing the grouping", () => {
    mountAt("?groupBy=module&q=crash");
    fireEvent.click(screen.getAllByRole("button", { name: "Show only core" })[0]);
    const params = new URLSearchParams(window.location.search);
    expect(params.get("module")).toBe("m-core");
    expect(params.has("groupBy")).toBe(false);
    expect(params.get("q")).toBe("crash");
  });
});
