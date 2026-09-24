// ISS-1213: a row that does not say whether a box is on it, or when it last checked in, is refused by
// name, never placed on the board by a guess.
import { describe, expect, it } from "vitest";
import { requireHeld } from "./api";
import type { PipelineIssueRow } from "./types";

const row = (displayId: string, held?: unknown, lastCheckInAt: unknown = null) =>
  ({ id: displayId, displayId, status: "testing", held, lastCheckInAt }) as unknown as PipelineIssueRow;
const noCheckIn = (displayId: string) =>
  ({ id: displayId, displayId, status: "testing", held: false }) as unknown as PipelineIssueRow;

describe("requireHeld", () => {
  it("passes a page whose every row says whether it is held and when it last checked in", () => {
    const page = { items: [row("ISS-1", true, "2026-09-24T18:50:58.000Z"), row("ISS-2", false)], totalCount: 2 };
    expect(requireHeld(page)).toBe(page);
  });

  it("refuses a page with a row missing `held`, naming the row", () => {
    const page = { items: [row("ISS-1", true), row("ISS-2")], totalCount: 2 };
    expect(() => requireHeld(page)).toThrow(/ISS-2.*cannot place those rows/u);
  });

  it("refuses a `held` that is not a boolean rather than coercing it", () => {
    expect(() => requireHeld({ items: [row("ISS-3", "false")], totalCount: 1 })).toThrow(/ISS-3/u);
  });

  it("names the first three and counts the rest", () => {
    const items = ["ISS-1", "ISS-2", "ISS-3", "ISS-4", "ISS-5"].map((d) => row(d));
    expect(() => requireHeld({ items, totalCount: 5 })).toThrow(/ISS-1, ISS-2, ISS-3 and 2 more/u);
  });

  it("refuses a page with a row missing `lastCheckInAt`, naming the row", () => {
    const page = { items: [row("ISS-1", true), noCheckIn("ISS-7")], totalCount: 2 };
    expect(() => requireHeld(page)).toThrow(/ISS-7.*when it last checked in/u);
  });

  it("refuses a `lastCheckInAt` that is not a time rather than reading it as none", () => {
    expect(() => requireHeld({ items: [row("ISS-8", false, "yesterday")], totalCount: 1 })).toThrow(/ISS-8/u);
  });

  it("names no issue key of its own and no code formatting in the message", () => {
    expect(() => requireHeld({ items: [row("ISS-9")], totalCount: 1 })).toThrow(/^[^`]*$/u);
    expect(() => requireHeld({ items: [row("ISS-9")], totalCount: 1 })).not.toThrow(/ISS-1213/u);
  });
});
