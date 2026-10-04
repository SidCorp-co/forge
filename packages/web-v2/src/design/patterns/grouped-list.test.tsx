// @vitest-environment jsdom
//
// The shared list: label-first group headers, folding kept per session, and a row that peeks on a
// plain click but follows its link on a modified one.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, renderHook, screen, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroupedList, type ListGroup, type ListRowView, useGroupFold, visibleRows } from "./grouped-list";

expect.extend(matchers);
afterEach(cleanup);
beforeEach(() => sessionStorage.clear());

type R = { key: string; title: string };
const view = (r: R): ListRowView => ({ key: r.key, href: `/x/${r.key}`, title: r.title, facts: [], state: null, waitingOn: null, owner: null, age: null });
const GROUPS: ListGroup<R>[] = [
  { id: "needs_you", label: "Needs you", tone: "you", rows: [{ key: "ISS-1", title: "One" }] },
  { id: "done", label: "Done", collapsed: true, rows: [{ key: "ISS-2", title: "Two" }] },
  { id: "empty", label: "Empty", rows: [] },
];

function List({ onPeek }: { onPeek: (k: string) => void }) {
  const fold = useGroupFold("test:list");
  return <GroupedList ariaLabel="Things" groups={GROUPS} fold={fold} row={view} selected={null} onPeek={onPeek} />;
}

describe("GroupedList", () => {
  it("heads a group label-first with its count and hides empty groups", () => {
    render(<List onPeek={() => {}} />);
    const heads = screen.getAllByTestId("list-group");
    expect(heads.map((h) => h.textContent)).toEqual(["Needs you1", "Done1"]);
  });

  it("draws a row's key label in place of its key, and a list's own column words in the header", () => {
    const labelled = (r: R): ListRowView => ({ ...view(r), keyLabel: <i data-testid="label">{`path/${r.key}`}</i> });
    function Labelled() {
      const fold = useGroupFold("test:labelled");
      return (
        <GroupedList ariaLabel="Things" groups={GROUPS} fold={fold} row={labelled} selected={null} onPeek={() => {}} columns={{ key: "Module", meta: "Last landing" }} />
      );
    }
    render(<Labelled />);
    expect(screen.getByTestId("label").textContent).toBe("path/ISS-1");
    expect(screen.getByTestId("list-row").dataset.key).toBe("ISS-1");
    const header = screen.getByTestId("grouped-list").firstElementChild as HTMLElement;
    expect(header.textContent).toBe("ModuleTitleStateWaiting onLast landing");
  });

  it("starts a collapsed group folded and keeps an unfold in session storage", () => {
    render(<List onPeek={() => {}} />);
    expect(screen.queryByText("Two")).toBeNull();
    fireEvent.click(screen.getAllByTestId("list-group")[1] as HTMLElement);
    expect(screen.getByText("Two")).toBeInTheDocument();
    expect(JSON.parse(sessionStorage.getItem("test:list") ?? "{}")).toEqual({ done: false });
  });

  it("peeks on a plain click and leaves a modified click to the browser", () => {
    const onPeek = vi.fn();
    render(<List onPeek={onPeek} />);
    const row = screen.getByText("One").closest("a") as HTMLAnchorElement;
    expect(row.getAttribute("href")).toBe("/x/ISS-1");
    fireEvent.click(row, { metaKey: true });
    expect(onPeek).not.toHaveBeenCalled();
    fireEvent.click(row);
    expect(onPeek).toHaveBeenCalledWith("ISS-1");
  });

  it("steps j/k only through rows of open groups", () => {
    const { result } = renderHook(() => useGroupFold("test:fold"));
    expect(visibleRows(GROUPS, result.current).map((r) => r.key)).toEqual(["ISS-1"]);
    act(() => result.current.toggle("done", true));
    expect(visibleRows(GROUPS, result.current).map((r) => r.key)).toEqual(["ISS-1", "ISS-2"]);
  });
});
