// Feedback follows its work to the release: an ETA row, the person who owes the cut, the release as a link,
// and whether the reporter was told it shipped, or why nobody could be.

import type { FeedbackForecast } from "@forge/contracts/forecast";
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { EtaClock } from "@/features/forecast/eta";
import { renderWithQuery } from "@/test/render";
import type { FeedbackView } from "../types";
import { FeedbackFacts } from "./feedback-facts";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
const stamp = { label: "forecast" as const, asOf: at(0) };
const clock: EtaClock = { lang: "en", now: NOW, timeZone: "UTC" };
const landed = { ...stamp, kind: "landed" as const, landedAt: at(-30) };
const approval = {
  kind: "person" as const,
  mode: "approval" as const,
  who: "Dana Lee",
  act: "cut 0.1.0, then approve it",
  reason: "a holder approves",
  version: "0.1.0",
  holders: [{ id: "u1", name: "Dana Lee", kind: "human" as const }],
};
const delivery = { ...stamp, landing: landed, release: approval, inHands: null, shipped: null };

const NONE = { triage: false, verify: false, reopen: false, askVerify: false, redact: false, retarget: false, accept: false, snooze: false, message: false, note: false };
const view = (over: Partial<FeedbackView> = {}): FeedbackView =>
  ({
    id: "f1",
    key: "FB-4",
    kind: "bug",
    severity: "medium",
    phase: "resolved",
    status: "triaged",
    attentionGroup: "moving",
    waitingOn: { kind: "issue", who: "ISS-51", act: "ship", rule: "r", ref: "ISS-51", dueAt: null },
    target: { type: "screen", key: "The board", title: null },
    route: null,
    reporter: { id: "u9", name: "Ana", agency: "human" },
    whereSeen: null,
    duplicates: [],
    source: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    can: NONE,
    openSuggestions: 0,
    reporters: [],
    messages: [],
    verified: null,
    autoVerify: null,
    snoozed: null,
    shipNotice: null,
    ...over,
  }) as FeedbackView;
const forecast: FeedbackForecast = { key: "FB-4", triage: null, delivery };

describe("feedback follows its work to the release", () => {
  it("shows the ETA row, links the release and names who owes the cut", () => {
    renderWithQuery(<FeedbackFacts f={view()} slug="hop" forecast={forecast} clock={clock} />);
    expect(screen.getByTestId("facts-feedback-eta").textContent).toContain("ETA");
    const line = screen.getByTestId("feedback-forecast-line");
    expect(line.textContent).toBe("Fixed · waits on Dana Lee to cut 0.1.0, then approve it");
    expect(within(line).getByRole("link", { name: "0.1.0" }).getAttribute("href")).toBe("/projects/hop/releases/0.1.0");
  });

  it("says when the reporter was told, and for which release", () => {
    const f = view({ shipNotice: { state: "told", how: "notice", at: at(-5), release: "0.1.0", by: null, shipped: { at: at(-6), release: "0.1.0" } } });
    renderWithQuery(<FeedbackFacts f={f} slug="hop" />);
    const fact = screen.getByTestId("facts-ship-notice");
    expect(fact.textContent).toContain("Reporter told");
    expect(within(fact).getByRole("link", { name: "0.1.0" })).toBeTruthy();
  });

  it("names a reporter nobody could reach instead of leaving the row out", () => {
    const f = view({
      shipNotice: {
        state: "not_told",
        reason: "The reporter is an agent, which has no bell: tell it where it listens.",
        shipped: { at: null, release: null },
        beforeNotices: false,
      noticesBegan: null,
      },
    });
    renderWithQuery(<FeedbackFacts f={f} slug="hop" />);
    expect(screen.getByTestId("ship-notice-not-told").textContent).toContain("The reporter is an agent");
  });

  it("says shipped work shipped, in which release and when, never that no release has told", () => {
    const f = view({
      shipNotice: {
        state: "not_told",
        reason: "Shipped before release notices existed on this project (2026-10-07).",
        shipped: { at: "2026-10-07T04:13:32.795Z", release: "0.4.0-dev.89" },
        beforeNotices: true,
      noticesBegan: "2026-10-07T07:39:54.217Z",
      },
    });
    renderWithQuery(<FeedbackFacts f={f} slug="hop" />);
    const line = screen.getByTestId("ship-notice-not-told");
    expect(line.textContent).toContain("Shipped in 0.4.0-dev.89 on ");
    expect(screen.getByTestId("ship-notice-before").textContent).toMatch(/^Not told: shipped before release notices existed \(.*2026.*\)\.$/);
    expect(line.textContent).not.toContain("No release has told");
    expect(within(line).getByRole("link", { name: "0.4.0-dev.89" }).getAttribute("href")).toBe("/projects/hop/releases/0.4.0-dev.89");
  });

  it("shows no told row before the work has shipped", () => {
    renderWithQuery(<FeedbackFacts f={view({ phase: "planned" })} slug="hop" />);
    expect(screen.queryByTestId("facts-ship-notice")).toBeNull();
  });
});

