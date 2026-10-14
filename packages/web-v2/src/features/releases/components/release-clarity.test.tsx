// A release says why it asks to be split and what splitting does, and keeps its forecast and approval
// in its rail at every width: the template places the rail on a phone (detail-rail-place.test.tsx), so
// the release neither copies them above its summary nor leaves its Run group behind on its own.

import type { ScopeForecast } from "@forge/contracts/forecast";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReleaseBanner } from "./release-bits";
import * as facts from "./release-facts";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
const stamp = { label: "forecast" as const, asOf: at(0) };
const range = { ...stamp, kind: "forecast" as const, p50At: at(60), p85At: at(120), p50Minutes: 60, p85Minutes: 120, ahead: 0, aheadKeys: [], waitsOn: [], basis: { n: 20, floor: 10, windowDays: 60, complexity: null, cycleP50Minutes: 60, cycleP85Minutes: 90, throughputPerDay: 1, concurrency: 1, concurrencyBasis: "t" }, late: null };
const scope = { ...stamp, scope: "release", key: "0.1.0", title: "t", progress: { total: 3, shipped: 0, awaitingRelease: 0, toDo: 3 }, forecast: range, next: null, delivery: null, anchor: { at: "2026-10-07T00:00:00.000Z", event: { key: "forecast.event.none" } }, moved: null } as unknown as ScopeForecast;

const release = {
  version: "0.1.0",
  state: "draft",
  attentionGroup: "needs_you",
  approvalRequired: true,
  approval: null,
  approvers: [],
  waitingOn: { kind: "you", who: "You", act: "split this release into smaller releases", rule: "r", effect: "Cuts the oldest 50 merged issues; the other 13 wait for the next release.", ref: null, dueAt: null },
};

describe("a release that has to be split", () => {
  it("says what splitting does under the banner", () => {
    render(<ReleaseBanner r={release as never} />);
    expect(screen.getByTestId("wait-effect")).toHaveTextContent("Cuts the oldest 50 merged issues; the other 13 wait for the next release.");
  });
});

describe("a release's rail", () => {
  it("holds the approval and the forecast itself, hidden at no width and copied nowhere", () => {
    const { container } = render(<facts.ReleaseProperties r={{ ...release, issues: [], criteria: { total: 0, proven: 0, failing: 0, open: 0 }, cutCount: 0 } as never} forecast={scope} besideReader />);
    expect(screen.getByTestId("facts-approval")).toBeInTheDocument();
    expect(within(screen.getByTestId("facts-run")).getByTestId("facts-release-forecast")).toBeInTheDocument();
    expect(container.innerHTML).not.toMatch(/max-(sm|md|lg):hidden/);
    expect(Object.keys(facts)).not.toContain("ReleasePhoneStanding");
  });
});
