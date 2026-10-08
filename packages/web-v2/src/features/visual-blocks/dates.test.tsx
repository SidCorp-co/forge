// One date reading for every block the chat draws (REQ-32 BC-4): a moment shows as the Requirements
// list shows it (the forecast's own `doneDayText` / `whenText` in the viewer's timezone), whichever
// block kind carries it and whether it stands in a date column or inside a sentence such as the
// forecast basis. No block ever puts an ISO instant in front of a person.

import { blockToText, cellText, type VisualBlock } from "@forge/contracts/visual-blocks";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { VisualBlockProvider, VisualBlockView } from ".";
import { doneDayText, whenText } from "@/features/forecast/clock";

// the QA case: shipped at 18:19 UTC on 4 Oct, which is already 5 Oct for a viewer in Ho Chi Minh City
const SHIPPED = "2026-10-04T18:19:08.744Z";
const NEXT = "2099-03-02T09:30:00.000Z";
const ISO_ANYWHERE = /\d{4}-\d{2}-\d{2}/;

beforeAll(() => {
  process.env.TZ = "Asia/Ho_Chi_Minh";
});

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ width: 24, height: 12, top: 0, left: 0, right: 24, bottom: 12, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly cb: ResizeObserverCallback) {}
      observe(target: Element) {
        this.cb([{ target, contentRect: { width: 480, height: 240 } } as unknown as ResizeObserverEntry], this as never);
      }
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const clock = () => ({ lang: "en" as const, now: Date.now(), timeZone: "Asia/Ho_Chi_Minh" });
const listsShipped = () => doneDayText(SHIPPED, clock());

const frame = {
  fields: [
    { name: "key", type: "ref", label: "Requirement" },
    { name: "state", type: "status", label: "State" },
    { name: "p50At", type: "date", label: "Likely by (p50)" },
    { name: "p85At", type: "date", label: "Almost surely by (p85)" },
    { name: "basis", type: "string", label: "Forecast basis" },
    { name: "n", type: "number", label: "Done" },
  ],
  rows: [
    { key: "REQ-1", state: "done", p50At: null, p85At: null, basis: `shipped in 0.4.0-dev.6 (${SHIPPED})`, n: 3 },
    { key: "REQ-2", state: "open", p50At: NEXT, p85At: "2099-03-04T09:30:00.000Z", basis: "lands by then", n: 5 },
  ],
};
const base = { v: 1, source: { runId: "run-9" }, frame };
const facts = { queryId: "progress-by-requirement", asOf: "2026-10-08T09:30:00.000Z" };

const show = (block: unknown) =>
  render(
    <VisualBlockProvider value={{ projectSlug: undefined, sourceFacts: () => facts }}>
      <VisualBlockView block={block} />
    </VisualBlockProvider>,
  );
/** What a person reads of the drawing: its visible text, not the screen-reader copy. */
const seen = () => document.body.textContent ?? "";

describe("one date reading on every block", () => {
  it("the forecast basis in a table says the day the list says, not the ISO instant", () => {
    show({ ...base, kind: "table", columns: ["key", "basis"] });
    expect(listsShipped()).toBe("Oct 5");
    expect(seen()).toContain(`shipped in 0.4.0-dev.6 (${listsShipped()})`);
    expect(seen()).not.toMatch(ISO_ANYWHERE);
  });

  it("a date column reads as the list's ETA cell reads it", () => {
    show({ ...base, kind: "table", columns: ["key", "p50At", "p85At"] });
    expect(seen()).toContain(whenText(NEXT, clock()));
    expect(seen()).not.toMatch(ISO_ANYWHERE);
  });

  it("a status list's waiting-on sentence reads the same way", () => {
    show({ ...base, kind: "status-list", ref: "key", status: "state", waitingOn: "basis" });
    expect(seen()).toContain(`waiting on shipped in 0.4.0-dev.6 (${listsShipped()})`);
    expect(seen()).not.toMatch(ISO_ANYWHERE);
  });

  it("a timeline's dates and axis read the same way, and so does a chart's date axis", () => {
    show({ ...base, kind: "timeline", label: "key", p50: "p50At", p85: "p85At" });
    expect(seen()).not.toMatch(ISO_ANYWHERE);
    cleanup();
    show({ ...base, kind: "chart", variant: "line", x: "p50At", y: ["n"] });
    expect(seen()).not.toMatch(ISO_ANYWHERE);
  });

  it("the screen-reader copy of a drawing carries no ISO instant either", () => {
    for (const block of [
      { ...base, kind: "timeline", label: "key", p50: "p50At", p85: "p85At" },
      { ...base, kind: "chart", variant: "bar", x: "basis", y: ["n"] },
    ]) {
      show(block);
      expect(screen.getByTestId("visual-block-alt").textContent, block.kind).not.toMatch(ISO_ANYWHERE);
      cleanup();
    }
  });
});

describe("the contract's own text", () => {
  const table = { ...base, kind: "table", columns: ["key", "basis"] } as unknown as VisualBlock;

  it("keeps ISO where no screen reads it, for a stored fallback or an export", () => {
    expect(blockToText(table)).toContain(SHIPPED);
    expect(cellText(frame.fields[4] as never, frame.rows[0]?.basis)).toContain(SHIPPED);
  });

  it("reads every instant in a sentence through the reading it is handed, and nothing else", () => {
    const reading = { instant: (iso: string) => `<${iso.slice(5, 10)}>` };
    expect(cellText(frame.fields[4] as never, "between 2026-10-04T18:19:08.744Z and 2026-10-06, v0.4.0-dev.6", reading)).toBe("between <10-04> and <10-06>, v0.4.0-dev.6");
  });
});
