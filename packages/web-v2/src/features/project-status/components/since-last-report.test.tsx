import type { StatusReportDetail } from "@forge/contracts/status-reports";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InterfaceLanguageScope } from "@/lib/i18n/interface-language";
import copy from "@/lib/i18n/product-copy.json";
import { renderWithQuery } from "@/test/render";
import { AT, STATUS } from "../status-fixture";
import { weeklyCron, weeklyOf } from "./report-schedule";
import { SinceLastReport } from "./since-last-report";

// "Since last report" lays out what core derived from two kept reports: an issue newly shipped and
// the next release's date moved, old to new, in the reader's language; an empty part says so.

const clock = { lang: "en" as const, now: Date.parse(AT), timeZone: "UTC" };
const meta = (id: string, asOf: string) => ({
  id,
  projectId: "p1",
  asOf,
  days: 7,
  period: null,
  producer: { kind: "person" as const, user: { id: "u1", name: "Ann" }, schedule: null },
});

const detail: StatusReportDetail = {
  report: meta("r2", AT),
  previous: meta("r1", "2026-09-30T10:00:00.000Z"),
  status: STATUS,
  diff: {
    since: "2026-09-30T10:00:00.000Z",
    shipped: [{ version: "0.2.0", releasedAt: "2026-10-06T09:30:00.000Z", issues: [{ key: "ISS-11", title: "Saved boards keep every card" }] }],
    requirementsShipped: [],
    newlyLate: [],
    noLongerWaiting: [],
    waitsCut: false,
    moved: [{ kind: "release", key: "0.3.0", title: "0.3.0", from: "2026-10-09T10:00:00.000Z", to: "2026-10-12T10:00:00.000Z" }],
  },
};

describe("Since last report", () => {
  it("names the issue shipped since and the release date moved, old to new", () => {
    renderWithQuery(<SinceLastReport detail={detail} slug="hop" clock={clock} />);
    expect(screen.getByTestId("since-shipped").textContent).toContain("ISS-11");
    const moved = screen.getByTestId("since-moved").textContent ?? "";
    expect(moved).toContain("0.3.0");
    expect(moved).toMatch(/09\/10\/2026.*→.*12\/10\/2026/);
    expect(screen.getAllByText("Nothing changed here.")).toHaveLength(2);
  });

  it("reads in Vietnamese for a Vietnamese reader, and says the first report has nothing to compare", () => {
    renderWithQuery(
      <InterfaceLanguageScope language="vi">
        <SinceLastReport detail={{ ...detail, previous: null, diff: null }} slug="hop" clock={{ ...clock, lang: "vi" }} />
      </InterfaceLanguageScope>,
    );
    expect(screen.getByText(copy.vi["status.since.title"])).toBeTruthy();
    expect(screen.getByText(copy.vi["status.since.first"])).toBeTruthy();
  });

  it("writes the day and time a person picks as a weekly cron and reads it back", () => {
    expect(weeklyCron(1, "09:00")).toBe("0 9 * * 1");
    expect(weeklyOf("0 9 * * 1")).toEqual({ day: 1, time: "09:00" });
    expect(weeklyOf("*/5 * * * *")).toBeNull();
  });
});
