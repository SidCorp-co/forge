// @vitest-environment jsdom
//
// The one proposition these assert: a reader meets a record as a lead and a set
// of rows, and nothing of it is hidden from them. The defect they stand against
// is not a crash — it is the fence arriving as one undifferentiated code block
// with a 1,754-character field in the middle of it, which is what every agent
// record looked like before ISS-1089.

import type { ForgeRecordView } from "@forge/contracts";
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BodyView } from "./body-view";
import { RecordCard } from "./record-card";

expect.extend(matchers);
afterEach(cleanup);

const field = (key: string, value: string, over = 0) => ({ key, value, over });

const record = (over: Partial<ForgeRecordView> = {}): ForgeRecordView => ({
  kind: "confirmation",
  contract: 1,
  fields: [field("where", "the comment write door"), field("finding", "holds")],
  lead: "The comment screen admits a wall of text as one segment.",
  absent: ["beside"],
  at: 0,
  to: 0,
  ...over,
});

const long = "y".repeat(457);

describe("what a reader meets", () => {
  it("draws the lead as the card’s first line", () => {
    render(<RecordCard record={record()} />);
    const card = screen.getByTestId("forge-record-card");
    expect(card.querySelector("header")?.textContent).toContain(
      "The comment screen admits a wall of text as one segment.",
    );
  });

  // cm:guard the case ISS-1089's own review raised: every record written today carries no `lead`,
  // so the dominant input must have a defined outcome. No lead line, and NO field's text promoted
  // into its place — the substitution the parse refuses to make one layer down.
  it("draws no lead line, and no substitute, where the record carries none", () => {
    render(<RecordCard record={record({ lead: null, absent: ["lead", "beside"] })} />);
    const header = screen.getByTestId("forge-record-card").querySelector("header");
    expect(header?.textContent).toBe("confirmation · contract 1");
    expect(screen.getByText("holds")).toBeInTheDocument();
  });

  it("draws each field as its own labelled row", () => {
    render(<RecordCard record={record()} />);
    expect(screen.getByText("where")).toBeInTheDocument();
    expect(screen.getByText("the comment write door")).toBeInTheDocument();
    expect(screen.getByText("finding")).toBeInTheDocument();
  });

  // cm:guard the duplicate-key console error is the assertion, not decoration: both rows draw
  // either way, so an implementation keying on `field.key` passes every visible check here and
  // fails only this one — which is the whole reason it is easy to ship and easy to miss.
  it("draws a key repeated in one fence as two rows, each with a key of its own", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <RecordCard
        record={record({ fields: [field("decision", "first"), field("decision", "second")] })}
      />,
    );
    expect(screen.getAllByText("decision")).toHaveLength(2);
    expect(screen.getByText("second")).toBeInTheDocument();
    expect(errors.mock.calls.map((c) => String(c[0])).join(" ")).not.toContain(
      "Encountered two children with the same key",
    );
    errors.mockRestore();
  });

  it("names the record’s kind, and says nothing where the block carries no tag", () => {
    const { unmount } = render(<RecordCard record={record()} />);
    expect(screen.getByText("confirmation · contract 1")).toBeInTheDocument();
    unmount();
    render(<RecordCard record={record({ kind: null, contract: null })} />);
    expect(screen.queryByText(/contract/)).not.toBeInTheDocument();
  });
});

describe("a field past its budget", () => {
  const over = record({ fields: [field("why", long, 57)] });

  // cm:guard the whole value is in the DOM under BOTH readings, and this case is the one that stops
  // a later "just clamp it" turning the fold into a truncation nobody notices.
  it("is never truncated, under either reading", () => {
    const { unmount } = render(<RecordCard record={over} lens="product" />);
    expect(screen.getByText(long)).toBeInTheDocument();
    unmount();
    render(<RecordCard record={over} lens="technical" />);
    expect(screen.getByText(long)).toBeInTheDocument();
  });

  it("says how far over the budget it ran, where it is folded", () => {
    render(<RecordCard record={over} lens="product" />);
    expect(screen.getByText("Show all — 57 character(s) over budget")).toBeInTheDocument();
  });

  it("is first drawn folded on a project reading as product", () => {
    render(<RecordCard record={over} lens="product" />);
    expect(document.querySelector("details")?.open).toBe(false);
  });

  it("is first drawn unfolded on a project reading as technical", () => {
    render(<RecordCard record={over} lens="technical" />);
    expect(document.querySelector("details")?.open).toBe(true);
  });

  it("reads as product where the card is given no lens at all", () => {
    render(<RecordCard record={over} />);
    expect(document.querySelector("details")?.open).toBe(false);
  });

  // cm:guard the two cases below are about the LABEL and not the fold: native `<details>` toggles
  // without React, so a summary derived from the lens alone survives every assertion above and
  // names the opposite of what pressing it does (codex F4).
  // jsdom does not implement the native summary click, so the disclosure is driven the way the
  // browser drives it — the element's own `open`, then the `toggle` event that follows it.
  const toggle = (to: boolean) => {
    const details = document.querySelector("details") as HTMLDetailsElement;
    details.open = to;
    fireEvent(details, new Event("toggle", { bubbles: false }));
  };

  it("stops saying 'Show all' once the reader has shown it", () => {
    render(<RecordCard record={over} lens="product" />);
    toggle(true);
    expect(screen.getByText("Fold")).toBeInTheDocument();
    expect(screen.queryByText(/Show all/)).not.toBeInTheDocument();
  });

  it("stops saying 'Fold' once the reader has folded it", () => {
    render(<RecordCard record={over} lens="technical" />);
    toggle(false);
    expect(screen.getByText("Show all — 57 character(s) over budget")).toBeInTheDocument();
  });

  it("folds nothing where every field is inside the budget", () => {
    render(<RecordCard record={record()} lens="product" />);
    expect(document.querySelector("details")).toBeNull();
  });
});

describe("the prose the writer wrote around the fence", () => {
  const body = [
    "## Confirmation",
    "",
    "```forge-record",
    "finding: holds",
    "```",
    "",
    "`forge-record: confirmation · contract 1`",
    "",
    "And a sentence the writer added below.",
  ].join("\n");
  const at = body.indexOf("```forge-record");
  const to = body.indexOf("And a sentence") - 2;

  it("keeps the heading above the card and the closing sentence below it", () => {
    render(
      <BodyView
        body={body}
        format="markdown"
        record={record({ fields: [field("finding", "holds")], lead: null, at, to })}
      />,
    );
    const drawn = document.body.textContent ?? "";
    expect(drawn.indexOf("Confirmation")).toBeLessThan(drawn.indexOf("holds"));
    expect(drawn.indexOf("holds")).toBeLessThan(drawn.indexOf("And a sentence"));
  });

  // cm:guard the fence's own bytes must not reach the reader twice — once as the card and once as
  // the code block markdown would make of them. That double is the defect, wearing a card.
  it("draws the fence once, as the card, and never also as a code block", () => {
    render(
      <BodyView
        body={body}
        format="markdown"
        record={record({ fields: [field("finding", "holds")], lead: null, at, to })}
      />,
    );
    expect(document.body.textContent).not.toContain("```forge-record");
    expect(screen.getAllByText("holds")).toHaveLength(1);
  });

  // cm:guard a reference link written on one side of the fence and defined on the other resolved
  // before this change, because one `<Markdown>` held the whole body. Splitting the document splits
  // its reference table with it, and this case is what says the definitions travel (codex F3).
  it("resolves a reference link defined on the other side of the record", () => {
    const withRef = [
      "See the [evidence][proof] before the record.",
      "",
      "```forge-record",
      "finding: holds",
      "```",
      "",
      "[proof]: https://example.com/run/1",
    ].join("\n");
    const refAt = withRef.indexOf("```forge-record");
    const refTo = withRef.indexOf("[proof]:") - 2;
    render(
      <BodyView
        body={withRef}
        format="markdown"
        record={record({ fields: [field("finding", "holds")], lead: null, at: refAt, to: refTo })}
      />,
    );
    const link = document.querySelector("a[href='https://example.com/run/1']");
    expect(link?.textContent).toBe("evidence");
    expect(document.body.textContent).not.toContain("[evidence][proof]");
  });

  // cm:guard CommonMark resolves a label to its FIRST definition. A body defining `[proof]` above
  // the record and again below it links to the first under one parse, and a split that appended the
  // shared table to a half still carrying its own local second definition would link to the second
  // (codex F3, still open at its first recheck — this is the case that closed it).
  it("resolves a duplicated label to the document's first definition, as one parse does", () => {
    const dup = [
      "[proof]: https://example.com/first",
      "",
      "Above the record.",
      "",
      "```forge-record",
      "finding: holds",
      "```",
      "",
      "[proof]: https://example.com/second",
      "",
      "See the [evidence][proof] below the record.",
    ].join("\n");
    const dupAt = dup.indexOf("```forge-record");
    const dupTo = dupAt + "```forge-record\nfinding: holds\n```".length;
    render(
      <BodyView
        body={dup}
        format="markdown"
        record={record({ fields: [field("finding", "holds")], lead: null, at: dupAt, to: dupTo })}
      />,
    );
    expect(document.querySelector("a")?.getAttribute("href")).toBe("https://example.com/first");
  });

  // cm:guard a definition-shaped line inside a fenced code example is the example's own text. The
  // first fix for F3 ran a regex over the half and deleted it out of the code block the writer was
  // using to teach the syntax (codex F5).
  it("leaves a definition-shaped line inside a code example on the screen", () => {
    const teaching = [
      "Write the definition like this:",
      "",
      "~~~",
      "[proof]: https://example.com/how-to",
      "~~~",
      "",
      "```forge-record",
      "finding: holds",
      "```",
    ].join("\n");
    const teachAt = teaching.indexOf("```forge-record");
    const teachTo = teaching.length;
    render(
      <BodyView
        body={teaching}
        format="markdown"
        record={record({
          fields: [field("finding", "holds")],
          lead: null,
          at: teachAt,
          to: teachTo,
        })}
      />,
    );
    expect(document.body.textContent).toContain("[proof]: https://example.com/how-to");
  });

  it("draws an ordinary markdown comment exactly as it did before, with no card", () => {
    render(<BodyView body="Merged and deployed." format="markdown" record={null} />);
    expect(screen.queryByTestId("forge-record-card")).not.toBeInTheDocument();
    expect(screen.getByText("Merged and deployed.")).toBeInTheDocument();
  });
});
