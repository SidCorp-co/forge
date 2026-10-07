// Releases opens on what comes next: each requirement with work still to land and when it is in
// people's hands, then the draft and the act it waits on — named once, never dated.

import type { ComingNextForecast, DeliveryForecast, Forecast, ScopeForecast } from "@forge/contracts/forecast";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ReleaseSummary } from "../types";
import { ComingNext } from "./coming-next";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
const stamp = { label: "forecast" as const, asOf: at(0) };
const range: Forecast = {
  ...stamp,
  kind: "forecast",
  p50At: at(60),
  p85At: at(240),
  p50Minutes: 60,
  p85Minutes: 240,
  ahead: 0,
  aheadKeys: [],
  waitsOn: [],
  basis: { n: 20, floor: 10, windowDays: 60, complexity: null, cycleP50Minutes: 60, cycleP85Minutes: 90, throughputPerDay: 2, concurrency: 2, concurrencyBasis: "b" },
};
const manual = { kind: "person" as const, mode: "manual" as const, who: "A project admin", act: "cut 0.1.0", reason: "an admin cuts each release" };
const delivery = (landing: Forecast): DeliveryForecast => ({ ...stamp, landing, release: manual, inHands: null, shipped: null });
const landed: Forecast = { ...stamp, kind: "landed", landedAt: at(-90) };

const req: ScopeForecast = { ...stamp, scope: "requirement", key: "REQ-4", title: "The board keeps its cards", total: 3, landed: 1, forecast: range, next: null, delivery: delivery(range) };
const draftScope: ScopeForecast = {
  ...stamp,
  scope: "release",
  key: "draft",
  title: null,
  total: 2,
  landed: 2,
  forecast: landed,
  next: { ...stamp, kind: "paused", who: "A project admin", act: "cut 0.1.0", reason: "r", ref: null },
  delivery: delivery(landed),
};
const next: ComingNextForecast = { ...stamp, projectId: "p", requirements: [req], draft: draftScope };
const draft = {
  key: "0.1.0",
  version: "0.1.0",
  state: "draft",
  issueCount: 2,
  waitingOn: { kind: "you", who: "You", act: "cut 0.1.0", rule: "an admin cuts the version", ref: null, dueAt: null },
} as unknown as ReleaseSummary;

describe("Coming next on Releases", () => {
  it("lists the requirement with its landing range and the person the release waits on", () => {
    render(<ComingNext next={next} draft={draft} slug="hop" now={NOW} />);
    const row = screen.getByTestId("coming-next-requirement");
    expect(row.getAttribute("data-key")).toBe("REQ-4");
    expect(row.textContent).toContain("1/3 landed");
    expect(screen.getByTestId("coming-next-line").textContent).toBe("Forecast lands in 1.0 h – 4.0 h · then waits on A project admin to cut 0.1.0");
  });

  it("says the draft's act once, as the viewer's own turn, beside all of it landed", () => {
    render(<ComingNext next={next} draft={draft} slug="hop" now={NOW} />);
    expect(screen.getByTestId("coming-next-draft-turn").textContent).toBe("Waiting on you: cut 0.1.0");
    const landedLine = screen.getByTestId("coming-next-draft-line").textContent ?? "";
    expect(landedLine).toMatch(/^All 2 landed by /);
    expect(landedLine).not.toContain("cut 0.1.0");
  });

  it("draws nothing where no work is open and no draft waits", () => {
    const { container } = render(<ComingNext next={{ ...next, requirements: [] }} draft={undefined} slug="hop" now={NOW} />);
    expect(container.textContent).toBe("");
  });
});
