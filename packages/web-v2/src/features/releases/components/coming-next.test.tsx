// Releases opens on what comes next: each requirement with work still to land and, in its ETA column,
// when it is in people's hands as a clock, then the draft and the act it waits on — named once, never dated.

import { forecastWait, RULE, say, waitingOn } from "@/test/said";
import type { ComingNextForecast, DeliveryForecast, Forecast, ScopeForecast } from "@forge/contracts/forecast";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { EtaClock } from "@/features/forecast/eta";
import type { ReleaseSummary } from "../types";
import { ComingNext } from "./coming-next";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const clock: EtaClock = { lang: "vi", now: NOW, timeZone: "UTC" };
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
const stamp = { label: "forecast" as const, asOf: at(0) };
const range: Forecast = {
  ...stamp,
  kind: "forecast", anchoredAt: "2026-10-07T00:00:00.000Z", confidence: { level: "medium", n: 12, spread: 0.5 },
  p50At: at(60),
  p85At: at(240),
  p50Minutes: 60,
  p85Minutes: 240,
  ahead: 0,
  aheadKeys: [],
  waitsOn: [],
  basis: { n: 20, floor: 10, windowDays: 60, complexity: null, cycleP50Minutes: 60, cycleP85Minutes: 90, throughputPerDay: 2, concurrency: 2, concurrencyBasis: "b" },
  late: null,
};
const manual = { kind: "person" as const, mode: "manual" as const, ...forecastWait(say("standing.who.named", { name: "Ada" }), say("standing.act.cut", { v: "0.1.0", more: null }), say("forecast.reason.manual")), version: "0.1.0", holders: [] };
const delivery = (landing: Forecast): DeliveryForecast => ({ ...stamp, landing, release: manual, inHands: null, shipped: null });
const landed: Forecast = { ...stamp, kind: "landed", landedAt: at(-90) };

const req: ScopeForecast = { ...stamp, scope: "requirement", anchor: { at: "2026-10-07T00:00:00.000Z", event: { key: "forecast.event.none" } }, moved: null, key: "REQ-4", title: "The board keeps its cards", progress: { total: 3, shipped: 0, awaitingRelease: 1, toDo: 2 }, forecast: range, next: null, delivery: delivery(range) };
const draftScope: ScopeForecast = {
  ...stamp,
  scope: "release", anchor: { at: "2026-10-07T00:00:00.000Z", event: { key: "forecast.event.none" } }, moved: null,
  key: "draft",
  title: null,
  progress: { total: 2, shipped: 0, awaitingRelease: 2, toDo: 0 },
  forecast: landed,
  next: { ...stamp, kind: "paused", ...forecastWait(say("standing.who.named", { name: "Ada" }), say("standing.act.cut", { v: "0.1.0", more: null }), RULE), ref: null, since: null, late: null },
  delivery: delivery(landed),
};
const next: ComingNextForecast = { ...stamp, projectId: "p", requirements: [req], draft: draftScope };
const draft = {
  key: "0.1.0",
  version: "0.1.0",
  state: "draft",
  issueCount: 2,
  waitingOn: waitingOn("you", { who: say("standing.who.you"), act: say("standing.act.cut", { v: "0.1.0", more: null }), rule: RULE }),
} as unknown as ReleaseSummary;

describe("Coming next on Releases", () => {
  it("lists the requirement with its landing as a clock in the ETA column, then the person who cuts the release", () => {
    render(<ComingNext next={next} draft={draft} slug="hop" clock={clock} />);
    expect(screen.getByTestId("coming-next-header").textContent).toContain("Dự kiến"); // i18n-allow: asserts the vi ETA copy
    const row = screen.getByTestId("coming-next-requirement");
    expect(row.getAttribute("data-key")).toBe("REQ-4");
    expect(within(row).getByTestId("issue-progress").textContent).toBe("0 shipped · 1 landed, awaiting release · 2 to do");
    const cell = within(row).getByTestId("eta-cell");
    expect(within(cell).getByTestId("eta-line").textContent).toBe("13:00");
    expect(within(cell).getByTestId("eta-sub").textContent).toBe("rồi chờ Ada cắt"); // i18n-allow: asserts the vi ETA copy
    expect(cell.getAttribute("title")).toMatch(/^Trong 1,0 giờ – 4,0 giờ · tính lúc 12:00\./); // i18n-allow: asserts the vi ETA copy
    expect(row.textContent).not.toMatch(/\d+(\.\d)? (min|h|d)\b/);
  });

  it("says the draft's act once, as the viewer's own turn, beside the day all of it landed", () => {
    render(<ComingNext next={next} draft={draft} slug="hop" clock={clock} />);
    expect(screen.getByTestId("coming-next-draft-turn").textContent).toBe("Waiting on you: cut 0.1.0");
    const row = screen.getByTestId("coming-next-draft");
    expect(within(row).getByTestId("issue-progress").textContent).toBe("0 shipped · 2 landed, awaiting release · 0 to do");
    const cell = within(row).getByTestId("eta-cell");
    expect(cell.getAttribute("data-kind")).toBe("landed");
    expect(cell.textContent).toBe("Xong code, chờ release"); // i18n-allow: asserts the vi ETA copy
    expect(cell.querySelector("svg")).toBeNull();
    expect(cell.textContent).not.toContain("cut 0.1.0");
  });

  it("draws nothing where no work is open and no draft waits", () => {
    const { container } = render(<ComingNext next={{ ...next, requirements: [] }} draft={undefined} slug="hop" clock={clock} />);
    expect(container.textContent).toBe("");
  });
});
