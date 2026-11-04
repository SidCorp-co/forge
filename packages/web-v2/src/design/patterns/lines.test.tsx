// ISS-956: the owner read every line as too dark. The lines stay; the shared primitives draw them
// lighter, from two tokens: a divider between rows, under a table or list header and between peek
// items (neutral-4), and a region line between rail, content and peek and under a toolbar (neutral-5).
// A field keeps its own stronger border, so it still reads as a field. Every screen gets this from the
// primitives, so no screen names a line colour of its own for them.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Input } from "../primitives/input";
import { Table, TBody, TD, TH, THead, TR } from "../primitives/table";
import { GroupedList } from "./grouped-list";
import { ListToolbar } from "./list-page";
import { PeekPanel, type PeekState } from "./peek-panel";
import { RowItem, RowList } from "./row-list";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const css = (file: string) => readFileSync(resolve(__dirname, "../../styles", file), "utf8");

/** Every border colour class an element and its descendants carry; a control (a button, a link, a key cap, a field) keeps its own border. */
function lineClasses(el: Element): string[] {
  const control = (e: Element) => e.closest("button, a, kbd, input, textarea, select") !== null;
  const all = [el, ...Array.from(el.querySelectorAll("*"))].filter((e) => !control(e));
  return all.flatMap((e) => (e.getAttribute("class") ?? "").split(/\s+/).filter((c) => /(^|:)border-line(-|$)/.test(c)));
}

const peek: PeekState = { open: "A-1", position: { at: 1, of: 2 }, set: () => {}, move: () => {} };

describe("ISS-956 lighter lines", () => {
  it("defines a divider at neutral-4 and a region line at neutral-5, as utilities", () => {
    const tokens = css("tokens.css");
    expect(tokens).toMatch(/--border-divider:\s*var\(--neutral-4\)/);
    expect(tokens).toMatch(/--border-region:\s*var\(--neutral-5\)/);
    const globals = css("globals.css");
    expect(globals).toMatch(/--color-line-divider:\s*var\(--border-divider\)/);
    expect(globals).toMatch(/--color-line-region:\s*var\(--border-region\)/);
  });

  it("RowList draws its rows and header with the divider", () => {
    render(
      <RowList header={<span>Head</span>} testId="rl">
        <RowItem title="One" testId="one" />
        <RowItem title="Two" testId="two" />
      </RowList>,
    );
    const classes = lineClasses(screen.getByTestId("rl"));
    expect(classes.length).toBeGreaterThan(0);
    expect(new Set(classes)).toEqual(new Set(["border-line-divider"]));
  });

  it("GroupedList draws its rows and column header with the divider", () => {
    const fold = { isOpen: () => true, toggle: () => {} };
    render(
      <GroupedList
        ariaLabel="Things"
        groups={[{ id: "g", label: "Group", tone: "neutral", rows: ["a", "b"] }]}
        fold={fold as never}
        row={(r: string) => ({ key: r, href: `/x/${r}`, title: r, facts: [], state: null, waitingOn: null, owner: null, age: null })}
        selected={null}
        onPeek={() => {}}
      />,
    );
    const rows = screen.getAllByTestId("list-row");
    for (const r of rows) expect(r).toHaveClass("border-line-divider");
    expect(screen.getByTestId("list-header")).toHaveClass("border-line-divider");
    expect(lineClasses(screen.getByTestId("grouped-list"))).not.toContain("border-line-subtle");
  });

  it("PeekPanel draws its edge and its bars as region lines", () => {
    render(
      <PeekPanel peek={peek} listLabel="Things" noun="Thing" full={{ href: "/x/A-1" }} foot={<p>acts</p>}>
        <p>body</p>
      </PeekPanel>,
    );
    const classes = lineClasses(screen.getByTestId("peek-panel"));
    expect(classes.length).toBeGreaterThan(0);
    expect(new Set(classes)).toEqual(new Set(["border-line-region"]));
  });

  it("a toolbar sits on a region line, and a table's header and rows on dividers", () => {
    render(
      <>
        <ListToolbar testId="tb">
          <span>filters</span>
        </ListToolbar>
        <Table>
          <THead data-testid="thead">
            <TR>
              <TH>H</TH>
            </TR>
          </THead>
          <TBody>
            <TR data-testid="tr">
              <TD>c</TD>
            </TR>
          </TBody>
        </Table>
      </>,
    );
    expect(screen.getByTestId("tb")).toHaveClass("border-line-region");
    expect(screen.getByTestId("thead")).toHaveClass("border-line-divider");
    expect(screen.getByTestId("tr")).toHaveClass("border-line-divider");
  });

  it("a field keeps its own field border, never a divider or region line", () => {
    render(<Input aria-label="Name" />);
    const field = screen.getByRole("textbox", { name: "Name" });
    expect(field).toHaveClass("border-line-strong");
    expect(field).not.toHaveClass("border-line-divider");
    expect(field).not.toHaveClass("border-line-region");
  });
});
