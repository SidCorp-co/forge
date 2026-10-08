// A visual block is drawn through the registry. What must hold: the three kinds draw their frame
// (table sorted and cut as the block says, kpi figures with deltas, status rows linking to what they
// name), each drawn block shows its source, and a block this screen cannot draw is named, never dropped.

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { VisualBlockProvider, VisualBlockView } from ".";
import { refHref } from "./ref-link";

afterEach(cleanup);

const frame = {
  fields: [
    { name: "key", type: "ref", label: "Item" },
    { name: "status", type: "status", label: "Status" },
    { name: "done", type: "number", label: "Done" },
    { name: "total", type: "number", label: "Total" },
    { name: "delta", type: "number", label: "Change" },
    { name: "who", type: "string", label: "Who" },
  ],
  rows: [
    { key: "ISS-12", status: "open", done: 3, total: 9, delta: 2, who: "Ana" },
    { key: "REQ-3", status: "agreed", done: 7, total: 8, delta: -1, who: null },
    { key: "0.4.0", status: "cut", done: 1, total: 1, delta: 0, who: "Bo" },
  ],
};
const base = { v: 1, source: { runId: "run-7" }, frame };

function show(block: unknown, slug: string | null = "forge-dev", facts = true) {
  return render(
    <VisualBlockProvider
      value={{
        projectSlug: slug ?? undefined,
        ...(facts ? { sourceFacts: () => ({ queryId: "progress-by-requirement", asOf: "2026-10-08T09:30:00.000Z" }) } : {}),
      }}
    >
      <VisualBlockView block={block} />
    </VisualBlockProvider>,
  );
}

describe("table block", () => {
  it("draws the chosen columns as a table, in the block's order", () => {
    show({ ...base, kind: "table", columns: ["status", "key"] });
    const heads = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(heads).toEqual(["Status", "Item"]);
    expect(screen.getAllByRole("row")).toHaveLength(4);
  });

  it("sorts as the block says and cuts to its limit, saying how many rows it left out", () => {
    show({ ...base, kind: "table", columns: ["key", "done"], sort: { field: "done", dir: "desc" }, limit: 2 });
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((r) => r.textContent)).toEqual(["REQ-37", "ISS-123"]);
    expect(screen.getByText("Showing 2 of 3 rows.")).toBeTruthy();
  });

  it("links a ref cell to the issue, requirement or release it names", () => {
    show({ ...base, kind: "table", columns: ["key"] });
    expect(screen.getByRole("link", { name: "ISS-12" }).getAttribute("href")).toBe("/projects/forge-dev/issues/ISS-12");
    expect(screen.getByRole("link", { name: "REQ-3" }).getAttribute("href")).toBe("/projects/forge-dev/requirements/REQ-3");
    expect(screen.getByRole("link", { name: "0.4.0" }).getAttribute("href")).toBe("/projects/forge-dev/releases/0.4.0");
  });

  it("draws a null cell as a dash", () => {
    show({ ...base, kind: "table", columns: ["who"] });
    expect(screen.getAllByRole("cell").map((c) => c.textContent)).toEqual(["Ana", "—", "Bo"]);
  });

  it("draws a ref as plain text where the project is not known", () => {
    show({ ...base, kind: "table", columns: ["key"] }, null);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("ISS-12")).toBeTruthy();
  });
});

describe("kpi block", () => {
  const kpi = {
    ...base,
    kind: "kpi",
    row: 1,
    figures: [
      { field: "done", label: "Proven", delta: "delta" },
      { field: "total", label: "Criteria" },
    ],
  };

  it("draws each figure from the row it names, with its signed delta", () => {
    show(kpi);
    const figures = screen.getAllByTestId("kpi-figure");
    expect(figures).toHaveLength(2);
    expect(figures[0]?.textContent).toBe("Proven7-1");
    expect(figures[1]?.textContent).toBe("Criteria8");
  });

  it("puts a plus on a rise", () => {
    show({ ...kpi, row: 0 });
    expect(screen.getAllByTestId("kpi-figure")[0]?.textContent).toBe("Proven3+2");
  });
});

describe("status-list block", () => {
  const list = { ...base, kind: "status-list", ref: "key", status: "status", waitingOn: "who" };

  it("draws a row per item with its status, naming who it waits on where it does", () => {
    show(list);
    const rows = screen.getAllByTestId("status-row");
    expect(rows.map((r) => r.textContent)).toEqual([
      "ISS-12Openwaiting on Ana",
      "REQ-3Agreed",
      "0.4.0Cutwaiting on Bo",
    ]);
  });

  it("links each item to what it names", () => {
    show(list);
    const hrefs = within(screen.getByRole("list")).getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual([
      "/projects/forge-dev/issues/ISS-12",
      "/projects/forge-dev/requirements/REQ-3",
      "/projects/forge-dev/releases/0.4.0",
    ]);
  });
});

describe("each block shows its source", () => {
  it("names the query and the moment it was read, with the run behind its disclosure", () => {
    show({ ...base, kind: "table", columns: ["key"] });
    const note = screen.getByTestId("visual-block-source");
    expect(screen.getByTestId("visual-block-query").textContent).toBe("progress-by-requirement");
    expect(note.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-08T09:30:00.000Z");
    fireEvent.click(screen.getByTestId("visual-block-source-toggle"));
    expect(screen.getByTestId("visual-block-source-detail").textContent).toContain("Report run run-7");
  });

  it("refuses a block whose run's query and read time it was not given, by name, never drawing it untraced", () => {
    show({ ...base, kind: "table", columns: ["key"] }, "forge-dev", false);
    const refused = screen.getByTestId("visual-block-refused");
    expect(refused.textContent).toContain("This answer has a table block that names no read its figures came from, so it is not drawn.");
    expect(refused.textContent).toContain("report run run-7: its query and read time were not stored with this block");
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByTestId("visual-block-source")).toBeNull();
  });

  it("labels a frame from an execution as computed", () => {
    show({ ...base, source: { executionId: "ex-2" }, kind: "table", columns: ["key"] }, "forge-dev", false);
    expect(screen.getByTestId("visual-block-source").textContent).toContain("Computed by execution ex-2");
  });
});

describe("a block this screen cannot draw is named, never dropped", () => {
  it("names a kind the contract does not know", () => {
    show({ v: 1, kind: "hologram" });
    expect(screen.getByTestId("visual-block-unsupported").textContent).toBe(
      "This answer has a hologram block this screen cannot show.",
    );
  });

  it("names a block with no kind, and a value that is no block", () => {
    show({ v: 1 });
    expect(screen.getByTestId("visual-block-unsupported").textContent).toBe("This answer has a nameless block this screen cannot show.");
  });

  it.each([{ raw: null }, { raw: 7 }, { raw: "x" }, { raw: [] }, { raw: { kind: 4 } }])("does not throw on $raw and draws a named row", ({ raw }) => {
    show(raw);
    expect(screen.getByTestId("visual-block-unsupported")).toBeTruthy();
  });

  it("refuses a block of a drawn kind that breaks its shape, naming the kind and the field", () => {
    show({ ...base, kind: "table", columns: ["nope"] });
    const refused = screen.getByTestId("visual-block-refused");
    expect(refused.textContent).toContain("This answer has a table block that does not match its shape");
    expect(refused.textContent).toContain('"nope" is not a field of the frame');
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("refuses a block that carries a figure of its own", () => {
    show({ ...base, kind: "table", columns: ["key"], total: 99 });
    expect(screen.getByTestId("visual-block-refused").textContent).toContain("a block holds no figure of its own");
  });
});

describe("refHref", () => {
  it("reads the entity from the key", () => {
    expect(refHref("p", "FB-9")).toBe("/projects/p/feedback/FB-9");
    expect(refHref("p", "v0.4.0-dev.5")).toBe("/projects/p/releases/v0.4.0-dev.5");
    expect(refHref("a b", "ISS-1")).toBe("/projects/a%20b/issues/ISS-1");
  });
});
