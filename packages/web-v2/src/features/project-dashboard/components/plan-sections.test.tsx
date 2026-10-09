import { say } from "@/test/said";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PlanRow } from "../ba-derive";
import { LandsThisWeek } from "./plan-sections";

const clock = { lang: "en" as const, now: Date.parse("2026-10-07T12:00:00Z"), timeZone: "UTC" };
const row = (over: Partial<PlanRow>): PlanRow => ({ kind: "requirement", key: "REQ-1", title: "Agree the checkout", release: null, href: "/projects/hop/requirements/REQ-1", eta: null, late: null, ...over });

describe("the dashboard's plan sections", () => {
  it("groups what waits on one release cut under that release, and names who cuts it", () => {
    const waiting = (key: string): PlanRow =>
      row({ key, title: `Title ${key}`, release: { version: "0.1.0", who: say("standing.who.holderOf", { perm: "releases.approve" }) }, eta: { kind: "range", p50At: "2026-10-08T10:00:00Z", p85At: "2026-10-08T12:00:00Z", tail: null, detail: "d" } });
    render(<LandsThisWeek slug="hop" rows={[waiting("REQ-1"), waiting("REQ-2"), waiting("REQ-3"), row({ key: "REQ-9" })]} clock={clock} />);
    const group = screen.getByTestId("lands-when-cut");
    expect(group).toHaveTextContent("3 land when 0.1.0 is cut — waits on A holder of releases.approve");
    expect(within(group).getByRole("link", { name: "0.1.0" })).toHaveAttribute("href", "/projects/hop/releases/0.1.0");
    expect(within(group).getAllByTestId("plan-row")).toHaveLength(3);
    expect(screen.getAllByTestId("plan-row")).toHaveLength(4);
    expect(screen.getByText("Lands this week 4")).toBeTruthy();
  });

  it("says so when nothing lands this week", () => {
    render(<LandsThisWeek slug="hop" rows={[]} clock={clock} />);
    expect(within(screen.getByTestId("lands-this-week")).getByText(/Nothing is forecast to land this week/)).toBeTruthy();
  });
});
