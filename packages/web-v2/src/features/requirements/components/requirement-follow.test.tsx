// A requirement follows its work to the release: its progress line names who owes the cut and links the release.

import { forecastWait, say } from "@/test/said";
import type { ScopeForecast } from "@forge/contracts/forecast";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CriteriaRest } from "./requirement-facts";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
const stamp = { label: "forecast" as const, asOf: at(0) };
const landed = { ...stamp, kind: "landed" as const, landedAt: at(-30) };
const approval = {
  kind: "person" as const,
  mode: "approval" as const,
  ...forecastWait(say("standing.who.named", { name: "Dana Lee" }), say("standing.act.cutThenApprove", { v: "0.1.0" }), say("forecast.reason.approval", { holders: null })),
  version: "0.1.0",
  holders: [{ id: "u1", name: "Dana Lee", kind: "human" as const }],
};
const delivery = { ...stamp, landing: landed, release: approval, inHands: null, shipped: null };

const scope: ScopeForecast = { ...stamp, scope: "requirement", anchor: { at: "2026-10-07T00:00:00.000Z", event: { key: "forecast.event.none" } }, moved: null, key: "REQ-19", title: "t", progress: { total: 2, shipped: 0, awaitingRelease: 2, toDo: 0 }, forecast: landed, next: null, delivery };

describe("a requirement follows its work to the release", () => {
  it("links the release its progress line names and names who owes the cut", () => {
    render(<CriteriaRest passing={7} criteria={11} scope={scope} slug="hop" />);
    const line = screen.getByTestId("criteria-rest-line");
    expect(line.textContent).toContain("waits on Dana Lee to cut 0.1.0");
    const link = within(line).getByRole("link", { name: "0.1.0" });
    expect(link.getAttribute("href")).toBe("/projects/hop/releases/0.1.0");
  });
});

