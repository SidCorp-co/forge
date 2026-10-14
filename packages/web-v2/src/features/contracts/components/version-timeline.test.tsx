// A contract's version timeline places each version at the day it was recorded. Versions recorded
// in one week land a few pixels apart on a phone and on a desktop alike, and each one's label drew
// over the next until the six read as one smear (catalog-api/admin-rest-v1). Versions closer than a
// label is wide share one mark now: the newest names it, the rest are counted on it.

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContractStandingRow, ContractVersionView } from "../types";
import { markVersions, VersionTimeline } from "./version-timeline";

const version = (v: string, recordedAt: string): ContractVersionView => ({
  version: v,
  recordedAt,
  classification: "additive",
  approval: "approved",
  decidedAt: recordedAt,
  previous: null,
  changes: [],
  decisionReason: null,
});

const row = { ref: "catalog-api/admin-rest-v1", window: null } as unknown as ContractStandingRow;

// Hours apart: the axis spans at least six days of padding, so these always land within one label.
const oneDay = ["1.0.0", "1.1.0", "2.0.0", "3.0.0", "3.1.0", "3.2.0"].map((v, i) => version(v, `2026-10-01T0${i + 1}:00:00.000Z`));
const monthsApart = [version("1.0.0", "2026-01-05T08:00:00.000Z"), version("2.0.0", "2026-05-05T08:00:00.000Z"), version("3.0.0", "2026-09-05T08:00:00.000Z")];

const axisWide = (px: number) => vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(px);
const labels = () => screen.getAllByTestId("timeline-mark").map((m) => m.textContent);

afterEach(() => vi.restoreAllMocks());

describe("a contract's version timeline", () => {
  it("draws six versions recorded hours apart as one mark, named by the newest and counting the rest", () => {
    axisWide(358);
    render(<VersionTimeline row={row} versions={oneDay} />);
    expect(screen.getAllByTestId("timeline-mark"), "each version drew its own label over the next").toHaveLength(1);
    expect(labels()[0]).toBe("3.2.0 +52026-10-01");
    expect(screen.getByRole("img").getAttribute("aria-label"), "the merged versions are still named").toBe("Versions of catalog-api/admin-rest-v1: 1.0.0, 1.1.0, 2.0.0, 3.0.0, 3.1.0, 3.2.0");
  });

  it("gives versions months apart a mark each, with nothing counted on them", () => {
    axisWide(358);
    render(<VersionTimeline row={row} versions={monthsApart} />);
    expect(screen.getAllByTestId("timeline-mark")).toHaveLength(3);
    expect(screen.queryByTestId("timeline-mark-more")).toBeNull();
  });

  it("draws every version alone before the axis is measured", () => {
    render(<VersionTimeline row={row} versions={oneDay} />);
    expect(screen.getAllByTestId("timeline-mark")).toHaveLength(6);
  });

  it("merges a version one pixel short of a label's width and keeps one a full label away", () => {
    const at = (iso: string) => new Date(iso).getTime();
    const a = version("1.0.0", "2026-10-01T00:00:00.000Z");
    const b = version("2.0.0", "2026-10-02T00:00:00.000Z");
    const px = (gap: number) => (t: number) => (t === at(b.recordedAt) ? gap : 0);
    expect(markVersions([a, b], px(79)).map((m) => [m.head.version, m.rest.length])).toEqual([["2.0.0", 1]]);
    expect(markVersions([a, b], px(80)).map((m) => [m.head.version, m.rest.length])).toEqual([["2.0.0", 0], ["1.0.0", 0]]);
  });
});
