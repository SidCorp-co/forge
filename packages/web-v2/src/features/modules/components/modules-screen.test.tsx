// @vitest-environment jsdom
//
// The Modules list reads core's per-module standing and only arranges it: Attention by the group core
// derived, Tree under each root; a search narrows it, the URL carries the view, and a read that
// stopped short of the open issues says so.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModuleRollupResponse } from "../types";
import { needsYou, rollupRow, standing } from "./module-fixtures";
import { ModulesScreen } from "./modules-screen";

expect.extend(matchers);
afterEach(cleanup);
beforeEach(() => {
  window.history.replaceState(null, "", "/projects/hop/modules");
  sessionStorage.clear();
});

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("./module-peek", () => ({ ModulePeek: ({ moduleSlug }: { moduleSlug: string }) => <aside data-testid="peek-stub">{moduleSlug}</aside> }));

const stuck = standing({
  attentionGroup: "stuck",
  open: 2,
  openByKind: { needs_you: 0, moving: 0, stuck: 2, queued: 0, paused: 0 },
  waitingOn: { kind: "issue", who: "ISS-9", act: "not started", rule: "blocks it", ref: "ISS-9", issueKey: "ISS-7" },
});

let DATA: ModuleRollupResponse;
const set = (over: Partial<ModuleRollupResponse> = {}) => {
  DATA = {
    activeWithinDays: 30,
    generatedAt: "2026-10-04T00:00:00.000Z",
    unassigned: { total: 2, open: 2, closed: 0, recentlyActive: 0 },
    issuesRead: { returned: 5, open: 5 },
    modules: [
      rollupRow("outreach", { name: "Outreach", description: "Calls and messages to families.", standing: { ...needsYou, childCount: 1 } }),
      rollupRow("zalo", { name: "Zalo", path: "outreach/zalo", parentId: "id-outreach", depth: 1, standing: stuck }),
      rollupRow("reports", { name: "Reports" }),
    ],
    ...over,
  };
};
let query: { data?: ModuleRollupResponse; isLoading: boolean; isError: boolean; error: unknown; refetch: () => void };
vi.mock("../hooks", () => ({ useModuleRollup: () => query }));
beforeEach(() => {
  set();
  query = { data: DATA, isLoading: false, isError: false, error: null, refetch: vi.fn() };
});

const keys = () => screen.queryAllByTestId("list-row").map((r) => r.dataset.key);
const heads = () => screen.getAllByTestId("list-group").map((g) => g.dataset.group);
const view = () => <ModulesScreen projectId="p" slug="hop" />;

describe("ModulesScreen", () => {
  it("groups by the attention group core derived, in its order, and folds Quiet", () => {
    render(view());
    expect(heads()).toEqual(["needs_you", "stuck", "quiet"]);
    expect(keys()).toEqual(["outreach", "zalo"]);
    fireEvent.click(screen.getByText("Quiet"));
    expect(keys()).toEqual(["outreach", "zalo", "reports"]);
  });

  it("heads the groups with their labels and counts and no explanatory sentence", () => {
    render(view());
    expect(screen.getAllByTestId("list-group").map((g) => g.textContent)).toEqual(["Needs you1", "Stuck1", "Quiet1"]);
  });

  it("reads the list's own column words and each row's state, waiting on and last landing", () => {
    render(view());
    const header = screen.getByTestId("grouped-list").firstElementChild as HTMLElement;
    expect(header.textContent).toBe("ModuleNameOpen issuesWaiting onLast landing");
    const first = screen.getAllByTestId("list-row")[0] as HTMLElement;
    expect(first.textContent).toContain("Outreach");
    expect(first.textContent).toContain("Open 3");
    expect(first.textContent).toContain("Running 1");
    expect(first.textContent).toContain("Children 1");
    expect(first.textContent).toContain("Calls and messages to families.");
    expect(first.textContent).toContain("You · ISS-5 · make a decision");
    expect(first.textContent).toContain("ISS-2");
    expect(screen.getAllByTestId("list-row")[1]?.textContent).toContain("None yet");
  });

  it("lists a child under its parent's root in Tree mode and counts what waits in each group", () => {
    window.history.replaceState(null, "", "/projects/hop/modules?group=tree");
    render(view());
    expect(heads()).toEqual(["tree:id-outreach", "tree:id-reports"]);
    expect(keys()).toEqual(["outreach", "zalo", "reports"]);
    const head = screen.getAllByTestId("list-group")[0] as HTMLElement;
    expect(head.textContent).toBe("outreach2Needs you 1Stuck 1");
  });

  it("narrows by path, name or description, and writes the text to the URL", () => {
    render(view());
    fireEvent.change(screen.getByRole("searchbox", { name: "Search modules" }), { target: { value: "families" } });
    expect(window.location.search).toBe("?q=families");
    expect(keys()).toEqual(["outreach"]);
  });

  it("says nothing matches rather than drawing an empty list", () => {
    window.history.replaceState(null, "", "/projects/hop/modules?q=zzz");
    render(view());
    expect(screen.getByText("Nothing matches this search.")).toBeInTheDocument();
  });

  it("opens a peek on a click and keeps the row's link for a modified one", () => {
    render(view());
    const row = screen.getAllByTestId("list-row")[0] as HTMLElement;
    expect(row).toHaveAttribute("href", "/projects/hop/modules/outreach");
    fireEvent.click(row);
    expect(window.location.search).toBe("?peek=outreach");
    expect(screen.getByTestId("peek-stub").textContent).toBe("outreach");
  });

  it("says how many open issues sit in no module", () => {
    render(view());
    expect(screen.getByText("Open issues in no module 2")).toBeInTheDocument();
  });

  it("says so when the counts read fewer open issues than are open, and not otherwise", () => {
    const { unmount } = render(view());
    expect(screen.queryByTestId("modules-truncated")).toBeNull();
    unmount();
    set({ issuesRead: { returned: 500, open: 612 } });
    query.data = DATA;
    render(view());
    expect(screen.getByTestId("modules-truncated").textContent).toContain("500 most recently written of 612 open issues; 112 older ones");
  });

  it("explains an empty project instead of drawing columns", () => {
    set({ modules: [] });
    query.data = DATA;
    render(view());
    expect(screen.getByText("No module has been declared")).toBeInTheDocument();
    expect(screen.queryByTestId("grouped-list")).toBeNull();
  });

  it("names a failed read and offers a retry", () => {
    query = { isLoading: false, isError: true, error: new Error("core is down"), refetch: vi.fn() };
    render(view());
    expect(screen.getByText(/core is down/)).toBeInTheDocument();
  });
});
