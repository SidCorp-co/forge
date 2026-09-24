// ISS-1213: a row that does not say whether a box is on it is refused by name, never read as Stalled.
import { describe, expect, it } from "vitest";
import { requireHeld } from "./api";
import type { PipelineIssueRow } from "./types";

const row = (displayId: string, held?: unknown) =>
  ({ id: displayId, displayId, status: "testing", held }) as unknown as PipelineIssueRow;

describe("requireHeld", () => {
  it("passes a page whose every row says whether it is held", () => {
    const page = { items: [row("ISS-1", true), row("ISS-2", false)], totalCount: 2 };
    expect(requireHeld(page)).toBe(page);
  });

  it("refuses a page with a row missing `held`, naming the row", () => {
    const page = { items: [row("ISS-1", true), row("ISS-2")], totalCount: 2 };
    expect(() => requireHeld(page)).toThrow(/ISS-2.*cannot tell Running from Stalled/u);
  });

  it("refuses a `held` that is not a boolean rather than coercing it", () => {
    expect(() => requireHeld({ items: [row("ISS-3", "false")], totalCount: 1 })).toThrow(/ISS-3/u);
  });

  it("names the first three and counts the rest", () => {
    const items = ["ISS-1", "ISS-2", "ISS-3", "ISS-4", "ISS-5"].map((d) => row(d));
    expect(() => requireHeld({ items, totalCount: 5 })).toThrow(/ISS-1, ISS-2, ISS-3 and 2 more/u);
  });
});
