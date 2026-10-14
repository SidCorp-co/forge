// Where a detail page's facts rail stands. From 1024px it stands beside the main column. Below it the
// rail moves, whole, to where the page marks the end of its own lead, behind one Facts disclosure:
// a reader on a phone learns what the page is before its properties, and the properties never sink
// under the whole page or split into pieces (the release page put Forecast and Approval above its
// summary and left Run at the very bottom). One rule in the template, so every page is held here.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { railBeside } from "@/test/rail-beside";
import { DetailLayout, DetailLeadEnd } from "./detail-tabs";
import { Fact, FactsGroup, FactsRail } from "./facts-rail";

const rail = (
  <FactsRail>
    <FactsGroup title="Approval">
      <Fact label="Policy">Required</Fact>
    </FactsGroup>
    <FactsGroup title="Run">
      <Fact label="Forecast">Oct 6</Fact>
    </FactsGroup>
  </FactsRail>
);

function page({ marked = true }: { marked?: boolean } = {}) {
  return render(
    <DetailLayout testId="layout" rail={rail}>
      <p>Release 0.1.0 brings 3 new features.</p>
      {marked ? <DetailLeadEnd /> : null}
      <p>New features: deploy a catalog design.</p>
    </DetailLayout>,
  );
}

const before = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

afterEach(() => vi.restoreAllMocks());

describe("below 1024px", () => {
  it("puts the page's own lead first, then the whole rail behind one Facts row, then the rest", () => {
    page();
    const lead = screen.getByText(/brings 3 new features/);
    const toggle = screen.getByRole("button", { name: /Facts/ });
    const body = screen.getByText(/New features: deploy/);
    expect(before(lead, toggle), "the lead stands above the rail").toBe(true);
    expect(before(toggle, body), "the rail stands above the long body").toBe(true);
    const details = screen.getByTestId("rail-facts");
    expect(within(details).getAllByTestId("facts-group"), "every group in the one disclosure").toHaveLength(2);
    expect(screen.getAllByTestId("rail-facts")).toHaveLength(1);
    expect(screen.getByTestId("layout").dataset.railPlace).toBe("lead");
  });

  it("opens folded, naming its groups, and unfolds onto the rail", async () => {
    page();
    const toggle = screen.getByRole("button", { name: /Facts/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("rail-facts-groups")).toHaveTextContent("Approval · Run");
    expect(screen.getByTestId("facts-rail")).not.toBeVisible();
    await userEvent.setup().click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("facts-rail")).toBeVisible();
  });

  it("keeps the rail whole after the content on a page that marks no lead", () => {
    page({ marked: false });
    expect(before(screen.getByText(/New features: deploy/), screen.getByRole("button", { name: /Facts/ }))).toBe(true);
  });
});

describe("from 1024px", () => {
  it("stands the rail beside the main column, open, with no Facts row", () => {
    railBeside();
    page();
    expect(screen.queryByTestId("rail-facts")).toBeNull();
    expect(screen.getByTestId("facts-rail")).toBeVisible();
    expect(screen.getByTestId("facts-rail").parentElement).toBe(screen.getByTestId("layout"));
    expect(screen.getByTestId("layout").dataset.railPlace).toBe("beside");
  });
});

describe("a rail folded on a wide screen", () => {
  const folded = () =>
    render(
      <DetailLayout testId="layout" rail={rail} railCollapsed>
        <p>Canvas</p>
        <DetailLeadEnd />
      </DetailLayout>,
    );

  it("is not drawn beside the content", () => {
    railBeside();
    folded();
    expect(screen.queryByTestId("facts-rail")).toBeNull();
    expect(screen.queryByTestId("rail-facts")).toBeNull();
  });

  it("is still offered behind Facts below 1024px", () => {
    folded();
    expect(screen.getByRole("button", { name: /Facts/ })).toBeInTheDocument();
  });
});

describe("a fact in its group", () => {
  it("never repeats the group's title as its label", () => {
    render(
      <FactsGroup title="Forecast">
        <Fact label="Forecast" testId="same">All 10 landed by Oct 6</Fact>
        <Fact label="Policy" testId="other">Required</Fact>
      </FactsGroup>,
    );
    expect(screen.getByTestId("same").querySelector("[data-fact-label]")).toBeNull();
    expect(screen.getByTestId("same")).toHaveTextContent("All 10 landed by Oct 6");
    expect(screen.getByTestId("other").querySelector("[data-fact-label]")).toHaveTextContent("Policy");
  });
});

// Each page on DetailLayout, and the file that marks where its lead ends (where the lead is drawn by
// a component of its own). A new page on the layout fails here until its lead is marked.
const LEAD_END_IN: Record<string, string> = {
  "src/features/releases/components/release-page.tsx": "src/features/releases/components/release-reader.tsx",
  "src/features/issues/components/issue-detail-screen.tsx": "src/features/issues/components/detail/issue-page-main.tsx",
};
const WEB = join(import.meta.dirname, "../../..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [relative(WEB, path)] : [];
  });
}

describe("every page on the detail layout", () => {
  const pages = sources(join(WEB, "src")).filter((f) => f !== "src/design/patterns/detail-tabs.tsx" && readFileSync(join(WEB, f), "utf8").includes("<DetailLayout"));

  it("is found", () => {
    expect(pages.length).toBeGreaterThanOrEqual(12);
  });

  it.each(pages)("%s marks where its own lead ends", (f) => {
    const marked = LEAD_END_IN[f] ?? f;
    expect(readFileSync(join(WEB, marked), "utf8"), `${marked} has no <DetailLeadEnd />`).toMatch(/<DetailLeadEnd\b/);
  });
});
