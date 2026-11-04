// ISS-956: the owner read every line as too dark. The lines stay; the shared primitives draw them
// lighter, from two tokens: a divider between rows, under a table or list header and between peek
// items (neutral-4), and a region line between rail, content and peek and under a toolbar (neutral-5).
// A field keeps its own stronger border, so it still reads as a field. Every screen gets this from the
// primitives, so no screen names a line colour of its own for them.
//
// Judge run e0121211 at dev.486 (ISS-956's spec, fixed forward under ISS-951 round 4): the peek's and
// the side panel's item and section dividers, and the issue page's, still drew --border-subtle
// (neutral-6). The item primitives a peek, a rail and a page hold draw the divider; the rail's edge
// is a region line.
//
// @direct-test-of packages/web-v2/src/design/patterns/facts-rail.tsx
// @direct-test-of packages/web-v2/src/design/patterns/section.tsx
// @direct-test-of packages/web-v2/src/design/primitives/disclosure.tsx
// @direct-test-of packages/web-v2/src/design/primitives/divider.tsx

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Disclosure } from "../primitives/disclosure";
import { Divider } from "../primitives/divider";
import { Input } from "../primitives/input";
import { PageSectionHeader } from "../primitives/page-section";
import { Table, TBody, TD, TH, THead, TR } from "../primitives/table";
import { CountSection } from "./count-section";
import { ExpandRow, ExpandRows } from "./expand-row";
import { Fact, FactsGroup, FactsRail } from "./facts-rail";
import { GroupedList } from "./grouped-list";
import { ListToolbar } from "./list-page";
import { PeekPanel, type PeekState } from "./peek-panel";
import { RowItem, RowList } from "./row-list";
import { Property, PropertyList, Section } from "./section";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const css = (file: string) => readFileSync(resolve(__dirname, "../../styles", file), "utf8");

/** Every border colour class an element and its descendants carry; a control (a button, a link, a key cap, a field) keeps its own border. */
function lineClasses(el: Element): string[] {
  const control = (e: Element) => e.closest("button, a, kbd, input, textarea, select") !== null;
  const all = [el, ...Array.from(el.querySelectorAll("*"))].filter((e) => !control(e));
  return all.flatMap((e) => (e.getAttribute("class") ?? "").split(/\s+/).filter((c) => /(^|:)border-line(-|$)/.test(c)));
}

/** Every line class, a border, a divide or a fill rule, outside a control: what a divider may be drawn with. */
function itemLines(el: Element): string[] {
  const control = (e: Element) => e.closest("button, a, kbd, input, textarea, select") !== null;
  const all = [el, ...Array.from(el.querySelectorAll("*"))].filter((e) => !control(e));
  return all.flatMap((e) => (e.getAttribute("class") ?? "").split(/\s+/).filter((c) => /(^|:)(border|divide|bg)-line(-|$)/.test(c)));
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
      <PeekPanel peek={peek} listLabel="Things" noun="Thing" full={{ href: "/x/A-1", origin: "things" }} foot={<p>acts</p>}>
        <p>body</p>
      </PeekPanel>,
    );
    const classes = lineClasses(screen.getByTestId("peek-panel"));
    expect(classes.length).toBeGreaterThan(0);
    expect(new Set(classes)).toEqual(new Set(["border-line-region"]));
  });

  it("the item and section lines a peek holds are dividers, between its region lines", () => {
    render(
      <PeekPanel peek={peek} listLabel="Things" noun="Thing" full={{ href: "/x/A-1", origin: "things" }} foot={<p>acts</p>}>
        <FactsGroup title="Properties">
          <Fact label="Owner">Lan</Fact>
        </FactsGroup>
        <FactsGroup title="Criteria">
          <Fact label="Met">2 of 4</Fact>
        </FactsGroup>
        <Section title="Description">text</Section>
        <Section title="Activity">
          <PropertyList>
            <Property label="Opened">Mon</Property>
            <Property label="Moved">Tue</Property>
          </PropertyList>
        </Section>
        <Disclosure title="Plan">steps</Disclosure>
        <Disclosure title="Files">files</Disclosure>
        <Divider />
      </PeekPanel>,
    );
    const body = screen.getByTestId("peek-body");
    const inside = itemLines(body);
    expect(inside.length).toBeGreaterThan(0);
    expect(new Set(inside.map((c) => c.replace(/^(border|divide|bg)-/, "")))).toEqual(new Set(["line-divider"]));
    expect(body.querySelector("hr")).toHaveClass("bg-line-divider");
    const panel = lineClasses(screen.getByTestId("peek-panel")).filter((c) => !inside.includes(c) && c !== "border-line-divider");
    expect(new Set(panel)).toEqual(new Set(["border-line-region"]));
  });

  it("a side panel's edge is a region line and its groups sit on dividers; a page's sections and rows too", () => {
    render(
      <>
        <FactsRail testId="rail">
          <FactsGroup title="One">
            <Fact label="A">a</Fact>
          </FactsGroup>
          <FactsGroup title="Two">
            <Fact label="B">b</Fact>
          </FactsGroup>
        </FactsRail>
        <div data-testid="page">
          <PageSectionHeader>head</PageSectionHeader>
          <CountSection label="Runs" count={0}>
            {null}
          </CountSection>
          <ExpandRows label="Rows">
            <ExpandRow id="r1" head="one">
              body
            </ExpandRow>
          </ExpandRows>
        </div>
      </>,
    );
    expect(screen.getByTestId("rail")).toHaveClass("border-line-region");
    expect(new Set(itemLines(screen.getByTestId("facts-rail-body")))).toEqual(new Set(["border-line-divider"]));
    const page = itemLines(screen.getByTestId("page"));
    expect(page.length).toBeGreaterThanOrEqual(3);
    expect(new Set(page)).toEqual(new Set(["border-line-divider"]));
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
