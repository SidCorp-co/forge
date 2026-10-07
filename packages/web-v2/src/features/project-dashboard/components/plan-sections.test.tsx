import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PlanRow } from "../ba-derive";
import { LandsThisWeek, LateItems } from "./plan-sections";

const clock = { lang: "en" as const, now: Date.parse("2026-10-07T12:00:00Z"), timeZone: "UTC" };
const row = (over: Partial<PlanRow>): PlanRow => ({ kind: "requirement", key: "REQ-1", title: "Agree the checkout", href: "/projects/hop/requirements/REQ-1", eta: null, late: null, ...over });

describe("the dashboard's plan sections", () => {
  it("shows a late item by how much, and a paused one by who it waits on", () => {
    render(
      <LateItems
        rows={[
          row({ late: { reason: "p85_passed", since: "x", byMinutes: 150 } }),
          row({ key: "FB-2", kind: "feedback", late: { reason: "waiting_over_day", since: "x", byMinutes: 360 }, eta: { kind: "waits", who: "A holder of feedback.approve", act: "triage it", detail: "d" } }),
        ]}
      />,
    );
    const by = screen.getAllByTestId("late-by").map((n) => n.textContent);
    expect(by).toEqual(["2.5 h past the latest similar work took", "Waiting on A holder of feedback.approve · 6.0 h over a day"]);
  });

  it("says so when nothing lands this week or is late", () => {
    render(
      <>
        <LandsThisWeek rows={[]} clock={clock} />
        <LateItems rows={[]} />
      </>,
    );
    expect(within(screen.getByTestId("lands-this-week")).getByText(/Nothing is forecast to land this week/)).toBeTruthy();
    expect(within(screen.getByTestId("late-items")).getByText(/Nothing is running past its estimate/)).toBeTruthy();
  });
});
