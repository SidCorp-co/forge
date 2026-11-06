// ISS-979 (owner ruling 2026-11-05, design README Grouping, revised 2026-11-05: the filled collapse
// triangle was unpleasant to look at): every grouped list reads as a hierarchy, flat. The group header is set apart by type and
// colour, never a tinted band: a dot, a semibold full-contrast label (amber where the group needs the
// person), its count as a pill, and a thin chevron AFTER the count, shown only on hover or keyboard
// focus and while the group is folded. Its rows are indented 32px, under the header's label. The
// witness (witness/activity.witness.tsx) measures the indent laid out; this holds the grammar.
//
// @direct-test-of packages/web-v2/src/design/patterns/group-header.tsx
// @direct-test-of packages/web-v2/src/design/patterns/grouped-list.tsx

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type GroupFold, GroupedList, type ListGroup, type ListRowView, useGroupFold } from "./grouped-list";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

interface Item {
  key: string;
  title: string;
}

const GROUPS: ListGroup<Item>[] = [
  { id: "you", label: "Needs you", tone: "you", rows: [{ key: "ISS-1", title: "First" }, { key: "ISS-2", title: "Second" }] },
  { id: "moving", label: "Moving", tone: "run", rows: [{ key: "ISS-3", title: "Third" }] },
  { id: "done", label: "Done", tone: "done", collapsed: true, rows: [{ key: "ISS-4", title: "Fourth" }] },
];

const row = (i: Item): ListRowView => ({ key: i.key, href: `/x/${i.key}`, title: i.title, facts: [], state: null, waitingOn: null, owner: null, age: null });

function List({ groups = GROUPS }: { groups?: ListGroup<Item>[] }) {
  const fold: GroupFold = useGroupFold("test:grouped-list-hierarchy");
  return <GroupedList ariaLabel="Things" groups={groups} fold={fold} row={row} selected={null} onPeek={() => {}} />;
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

const header = (id: string) => {
  const h = screen.getAllByTestId("list-group").find((g) => g.getAttribute("data-group") === id);
  if (!h) throw new Error(`no header for ${id}`);
  return h;
};
const classes = (el: Element | null) => (el?.getAttribute("class") ?? "").split(/\s+/);

describe("a grouped list reads as a hierarchy", () => {
  it("each header is a dot, its label, its count as a pill, then the chevron, in that order", () => {
    render(<List />);
    const h = header("you");
    const parts = [...h.children].map((c) => c.getAttribute("data-testid"));
    expect(parts).toEqual(["group-dot", "group-label", "group-count", "group-chevron"]);
    expect(within(h).getByTestId("group-label").textContent).toBe("Needs you");
    expect(within(h).getByTestId("group-count").textContent).toBe("2");
    expect(classes(within(h).getByTestId("group-count"))).toContain("rounded-full");
  });

  it("the header is set apart by type, not by a tinted band: semibold, larger, full contrast", () => {
    render(<List />);
    const c = classes(header("moving"));
    expect(c).toEqual(expect.arrayContaining(["font-semibold", "text-14", "text-fg", "bg-app"]));
    expect(c, "the header is a tinted band").not.toContain("bg-sunken");
    // only the group that needs the person takes amber; another reads full contrast
    expect(within(header("you")).getByTestId("group-label").getAttribute("style")).toContain("--amberw-600");
    expect(within(header("moving")).getByTestId("group-label").getAttribute("style")).toBeNull();
  });

  it("an open group's chevron shows only on hover or keyboard focus; a folded one's always, turned", () => {
    render(<List />);
    const open = classes(within(header("you")).getByTestId("group-chevron"));
    expect(open).toEqual(expect.arrayContaining(["opacity-0", "group-hover/header:opacity-100", "group-focus-visible/header:opacity-100"]));
    expect(open).not.toContain("-rotate-90");
    const folded = classes(within(header("done")).getByTestId("group-chevron"));
    expect(folded).toEqual(expect.arrayContaining(["opacity-100", "-rotate-90"]));
    expect(folded).not.toContain("opacity-0");
  });

  it("the header folds and opens its rows, and says which it is", () => {
    render(<List />);
    expect(screen.getAllByTestId("list-row").map((r) => r.getAttribute("data-key"))).toEqual(["ISS-1", "ISS-2", "ISS-3"]);
    fireEvent.click(header("you"));
    expect(header("you").getAttribute("aria-expanded")).toBe("false");
    expect(screen.getAllByTestId("list-row").map((r) => r.getAttribute("data-key"))).toEqual(["ISS-3"]);
    expect(classes(within(header("you")).getByTestId("group-chevron"))).toContain("opacity-100");
    fireEvent.click(header("done"));
    expect(screen.getAllByTestId("list-row").map((r) => r.getAttribute("data-key"))).toEqual(["ISS-3", "ISS-4"]);
  });

  it("rows, and the column header over them, are indented 32px, under the header's label", () => {
    render(<List />);
    for (const r of screen.getAllByTestId("list-row")) {
      expect(classes(r), "a row is not indented under its group").toContain("pl-8");
      expect(classes(r)).not.toContain("px-5");
    }
    expect(classes(screen.getByTestId("list-header"))).toContain("pl-8");
    // the label starts at 16px of padding, an 8px dot and an 8px gap: 32px, where the rows start
    expect(classes(header("you"))).toEqual(expect.arrayContaining(["pl-4", "gap-x-2"]));
    expect(classes(within(header("you")).getByTestId("group-dot"))).toContain("size-2");
  });
});

// On a phone a row that leads with its title has no key cell beside its state, so its state starts
// its own line at the left, never floating mid-row beside an empty cell (ISS-1072, the coordinator's
// check at 400 px of 2026-11-07); a keyed row keeps its state on the key's line, at the right
describe("a row's state on a phone", () => {
  const stateCell = (keyColumn: boolean) => {
    const fold = { isOpen: () => true, toggle: () => {} };
    render(<GroupedList ariaLabel="Things" groups={GROUPS.slice(1, 2)} fold={fold} row={(i) => ({ ...row(i), state: <b data-testid="st">Open</b> })} selected={null} onPeek={() => {}} keyColumn={keyColumn} />);
    const cell = screen.getByTestId("st").parentElement as HTMLElement;
    cleanup();
    return cell.className;
  };

  it("starts its own line at the left where the row leads with its title", () => {
    expect(stateCell(false)).toMatch(/max-md:col-span-3/);
    expect(stateCell(false)).toMatch(/max-md:justify-start/);
    expect(stateCell(false)).not.toMatch(/max-md:justify-end/);
  });

  it("sits at the right of the key's line where the row is keyed", () => {
    expect(stateCell(true)).toMatch(/max-md:col-span-2/);
    expect(stateCell(true)).toMatch(/max-md:justify-end/);
  });
});
