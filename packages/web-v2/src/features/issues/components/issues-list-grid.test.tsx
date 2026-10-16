// @vitest-environment jsdom
//
// ISS-1155 — the Issues list is five columns on a grid, not eleven in a table.
//
// jsdom runs no layout and loads no stylesheet, so what a pixel measures (no sideways scroll, a
// 36px row, the first row's top) is the production-build proof, taken in a browser. What can go red
// here is what that layout rests on: the markup is a grid with `minmax(0, …)` tracks and no
// `<table>`, the assistive tree is still one table with its headers, the cells are the five and
// nothing else, and the density choice changes what a row says.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/providers/toast-provider";
import { LIST_DENSITY_KEY } from "../list-density";
import type { IssueRow } from "../types";
import { GRID } from "./issue-grid";
import { IssuesListView } from "./issues-list-view";

expect.extend(matchers);
afterEach(cleanup);
beforeEach(() => window.localStorage.clear());
Element.prototype.scrollIntoView = vi.fn();

const issue = (n: number, over: Partial<IssueRow> = {}): IssueRow => ({
  id: `i${n}`,
  projectId: "p1",
  issSeq: n,
  displayId: `ISS-${n}`,
  title: `Issue number ${n}`,
  status: "in_progress",
  priority: "high",
  category: "bug",
  complexity: "m",
  assigneeId: null,
  createdById: "u1",
  creatorEmail: "ann.lee@example.co",
  creatorIsAgent: false,
  creatorLabel: "ann.lee@example.co",
  reopenCount: 0,
  mergedAt: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  statusEnteredAt: "2026-09-01T00:00:00.000Z",
  estimatedCost: 1.25,
  modules: [{ labelId: "m-web", name: "web", color: "#1f6f4a", isPrimary: true }],
  ...over,
});

let items: IssueRow[];

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/forge-dev/issues",
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));
vi.mock("@/features/shell", async () => {
  const actual = await vi.importActual<typeof import("@/features/shell")>("@/features/shell");
  return { ...actual, usePinnedViews: () => ({ isPinned: () => false, toggle: vi.fn(), remove: vi.fn() }) };
});
vi.mock("./release-gate-panel", () => ({ ReleaseGatePanel: () => null }));
vi.mock("../hooks", async () => {
  const actual = await vi.importActual<typeof import("../hooks")>("../hooks");
  return {
    ...actual,
    useIssues: () => ({
      data: { items, totalCount: items.length },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }),
    useModuleRollup: () => ({ data: undefined, isLoading: false, isError: false, error: null, refetch: vi.fn() }),
    useProjectMembers: () => ({ data: [] }),
    useProjectLabels: () => ({ data: [] }),
    useProjectModules: () => ({ modules: [], data: [], isLoading: false, isError: false, error: null, refetch: vi.fn() }),
    usePatchIssue: () => ({ mutate: vi.fn(), isPending: false }),
    useStatusExits: () => ({ exits: undefined, isPending: false, isError: false }),
  };
});

function mount(query = "", canWrite = true) {
  window.history.replaceState({}, "", `/projects/forge-dev/issues${query}`);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <IssuesListView scope={{ projectId: "p1", slug: "forge-dev" }} canWrite={canWrite} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  items = [issue(1), issue(2, { modules: [], category: null, priority: "none" })];
});

const headers = () => screen.getAllByRole("columnheader").map((h) => h.textContent?.trim());
const rowsOf = () => screen.getAllByRole("row").filter((r) => within(r).queryAllByRole("columnheader").length === 0);

describe("the grid", () => {
  it("renders no <table> element", () => {
    const { container } = mount();
    expect(container.querySelector("table, thead, tbody, th, td")).toBeNull();
  });

  it("reads to assistive technology as one table, with the headers and every row in it", () => {
    mount();
    const table = screen.getByRole("table", { name: "Issues" });
    expect(within(table).getAllByRole("columnheader").length).toBeGreaterThan(0);
    expect(within(table).getAllByRole("row")).toHaveLength(1 + items.length);
    expect(screen.getAllByRole("table")).toHaveLength(1);
  });

  it("keeps one table, one header row and every group's rows when grouped", () => {
    items = [issue(1, { priority: "high" }), issue(2, { priority: "low" })];
    mount("?groupBy=priority");
    const table = screen.getByRole("table", { name: "Issues" });
    expect(screen.getAllByRole("table")).toHaveLength(1);
    expect(within(table).getAllByRole("rowgroup")).toHaveLength(2);
    expect(within(table).getAllByText("Issue number 1")).toHaveLength(1);
    expect(within(table).getAllByText("Issue number 2")).toHaveLength(1);
    expect(within(table).getAllByRole("columnheader").filter((h) => h.textContent === "State")).toHaveLength(1);
  });

  it("gives every flexible track minmax(0, …), so no track holds the page at its content's width", () => {
    const templates = GRID.split(/\s+/).filter((c) => c.includes("grid-cols-"));
    expect(templates).toHaveLength(2);
    for (const template of templates) {
      const tracks = template.slice(template.indexOf("[") + 1, template.lastIndexOf("]")).split("_");
      const flexible = tracks.filter((t) => /fr|minmax|auto/.test(t));
      expect(flexible.length, template).toBeGreaterThan(0);
      for (const t of flexible.filter((f) => f !== "auto")) {
        expect(t, template).toMatch(/^minmax\(0,/);
      }
    }
  });
});

describe("the five columns", () => {
  it("are ID, title, state, priority and creator, in that order, with no Module, Updated, Complexity or Cost", () => {
    mount();
    expect(headers().filter(Boolean)).toEqual(["ID", "Title", "State", "Priority", "Creator"]);
    for (const gone of ["Module", "Updated", "Complexity", "Cost", "Status"]) {
      expect(screen.queryByRole("columnheader", { name: gone })).toBeNull();
    }
  });

  it("holds one cell per column, the select box and the menu beside them", () => {
    mount();
    const [first] = rowsOf();
    expect(within(first).getAllByRole("cell")).toHaveLength(7);
  });

  it("prints no cost and no complexity in a row", () => {
    mount();
    const [first] = rowsOf();
    expect(first.textContent).not.toMatch(/\$1\.25|\bMedium\b/);
  });
});

describe("the creator", () => {
  it("is an avatar of initials whose accessible name and tooltip are the full label, and prints no label", () => {
    mount();
    const [first] = rowsOf();
    const avatar = within(first).getByRole("img", { name: "ann.lee@example.co" });
    expect(avatar).toHaveAttribute("title", "ann.lee@example.co");
    expect(avatar).toHaveTextContent("AL");
    expect(first.textContent).not.toContain("ann.lee@example.co");
  });
});

describe("priority", () => {
  it("is coloured text and not a pill", () => {
    mount();
    const [first] = rowsOf();
    const word = within(first).getByText("High");
    expect(word.className).not.toMatch(/rounded|border|bg-/);
    expect(word.className).toMatch(/text-\[color:var\(--amberw-600\)\]/);
  });

  it("prints a dash for none", () => {
    mount();
    const second = rowsOf()[1];
    expect(within(second).getByText("—")).toBeInTheDocument();
    expect(within(second).queryByText("None")).toBeNull();
  });
});

describe("density", () => {
  const menuName = (d: string) => `Row density: ${d}`;

  it("is Compact by default: one line, no module, no kind, no creator name", () => {
    mount();
    const [first] = rowsOf();
    expect(screen.getByRole("button", { name: menuName("Compact") })).toBeInTheDocument();
    expect(within(first).queryByText("web")).toBeNull();
    expect(within(first).queryByText("bug")).toBeNull();
  });

  it("shows a second line of module, kind and creator name in Comfortable, each only when the issue has it", () => {
    window.localStorage.setItem(LIST_DENSITY_KEY, JSON.stringify("comfortable"));
    mount();
    const [first, second] = rowsOf();
    expect(within(first).getByText("web")).toBeInTheDocument();
    expect(within(first).getByText("bug")).toBeInTheDocument();
    expect(within(first).getByText("ann.lee@example.co")).toBeInTheDocument();
    expect(within(second).queryByText("web")).toBeNull();
    expect(within(second).queryByText("bug")).toBeNull();
  });

  it("keeps Comfortable's second line to one line, whatever the module, kind and creator label hold", () => {
    // jsdom runs no layout, so what is asserted is the markup the 56px bound rests on: a line that
    // cannot wrap, whose long members give way by ellipsis and whose short ones keep their size.
    // The measured row heights at 1024 and 1280 are the production-build proof.
    const longLabel = "a.very.long.creator.address.of.a.person@a-long-company-name.example.co";
    items = [
      issue(1, {
        category: "enhancement",
        creatorLabel: longLabel,
        modules: [{ labelId: "m-x", name: "a-module-with-a-rather-long-name", color: "#1f6f4a", isPrimary: true }],
      }),
    ];
    window.localStorage.setItem(LIST_DENSITY_KEY, JSON.stringify("comfortable"));
    mount();
    const [row] = rowsOf();
    const line = within(row).getByText(longLabel, { selector: "span" }).parentElement as HTMLElement;
    const tokens = line.className.split(/\s+/);
    // Each token is asserted on its own, so dropping any one of them goes red naming it: without
    // lg:flex the line never shows, without flex-nowrap it wraps again (criterion 13).
    expect(tokens).toContain("lg:flex");
    expect(tokens).toContain("flex-nowrap");
    expect(tokens).toContain("overflow-hidden");
    expect(tokens).toContain("min-w-0");
    expect(tokens).not.toContain("flex-wrap");
    const members = Array.from(line.children) as HTMLElement[];
    const [moduleBox, kindBox, creator] = members;
    expect(moduleBox.className).toMatch(/\bmin-w-0\b/);
    expect(moduleBox.className).toMatch(/\bshrink\b/);
    expect(kindBox.className).toMatch(/\bshrink-0\b/);
    expect(kindBox.className).toMatch(/whitespace-nowrap/);
    expect(creator.className).toMatch(/\bmin-w-0\b/);
    expect(creator.className).toMatch(/\btruncate\b/);
    expect(within(moduleBox).getByText("a-module-with-a-rather-long-name").className).toMatch(/\btruncate\b/);
  });

  it("is changed from the header's menu and kept for the next visit", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: menuName("Compact") }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Comfortable/ }));
    expect(screen.getByRole("button", { name: menuName("Comfortable") })).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(LIST_DENSITY_KEY) ?? "null")).toBe("comfortable");
    expect(within(rowsOf()[0]).getByText("web")).toBeInTheDocument();
  });

  it("reads a stored value that is neither density as Compact", () => {
    window.localStorage.setItem(LIST_DENSITY_KEY, JSON.stringify("spacious"));
    mount();
    expect(screen.getByRole("button", { name: menuName("Compact") })).toBeInTheDocument();
  });
});

describe("the rows are flat", () => {
  it("draws no bordered, rounded card around the list or an issue", () => {
    const { container } = mount();
    expect(container.querySelector("[class*='rounded-lg']")).toBeNull();
  });

  it("has one render of each issue at every width", () => {
    mount();
    expect(screen.getAllByText("Issue number 1")).toHaveLength(1);
  });
});

describe("behaviour that stays", () => {
  it("offers bulk selection to a writer, and the select-all box in the header", () => {
    mount();
    expect(screen.getByRole("checkbox", { name: "Select all issues on this page" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select ISS-1" })).toBeInTheDocument();
  });

  it("offers none to a viewer, and keeps every other cell", () => {
    mount("", false);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(within(rowsOf()[0]).getAllByRole("cell")).toHaveLength(7);
  });

  it("opens an issue from its ID and from its title", () => {
    mount();
    expect(screen.getByRole("button", { name: "Open ISS-1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open ISS-1: Issue number 1" })).toBeInTheDocument();
  });

  it("keeps the row menu", () => {
    mount();
    expect(screen.getAllByRole("button", { name: "Row actions" })).toHaveLength(items.length);
  });
});
