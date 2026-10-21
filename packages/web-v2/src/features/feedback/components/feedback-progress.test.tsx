// An item's progress, as its reader asks it: is work running and on which issues, and when it is done,
// or plainly why no date can be given. Every reason core gives for no date is said in words, never an
// empty ETA (VISION: state-never-lies); a wait names who owes it, and the release it cuts links.

import type { FeedbackProgress as Progress } from "@forge/contracts/forecast";
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROGRESS_CASES } from "@/test/feedback-progress";
import { fakeCore, renderWithQuery } from "@/test/render";
import { forecastWait, say } from "@/test/said";
import { FeedbackProgress } from "./feedback-progress";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

afterEach(() => vi.unstubAllGlobals());

const CASE = (key: string): Progress => {
  const p = PROGRESS_CASES.find((c) => c.key === key);
  if (!p) throw new Error(`no progress case ${key}`);
  return p;
};

async function shown(p: Progress | { status: number; body: unknown }) {
  const key = "key" in p ? p.key : "FB-99";
  const calls = fakeCore((c) => (c.path === `/projects/p1/forecast/feedback/${key}` ? ("status" in p ? p : { body: p }) : undefined));
  renderWithQuery(<FeedbackProgress projectId="p1" slug="hop" fbKey={key} />);
  await waitFor(() => expect(screen.getByTestId("feedback-progress").dataset.estimate ?? screen.queryByTestId("feedback-progress-unread")).toBeTruthy());
  return calls;
}

describe("the feedback item's progress block", () => {
  it("reads the item's own progress and says running work with the issues carrying it", async () => {
    const calls = await shown(CASE("FB-12"));
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /projects/p1/forecast/feedback/FB-12"]);
    const block = screen.getByTestId("feedback-progress");
    expect(block.dataset.work).toBe("running");
    expect(screen.getByTestId("feedback-progress-work").textContent).toContain("Running: 1 of 2 issues in progress");
    const issues = screen.getAllByTestId("feedback-progress-issue");
    expect(issues.map((i) => i.dataset.status)).toEqual(["in_progress", "open"]);
    expect(within(issues[0]).getByRole("link", { name: "ISS-41" }).getAttribute("href")).toBe("/projects/hop/issues/ISS-41");
  });

  it("dates work with a forecast, and says no reason where there is a date", async () => {
    await shown(CASE("FB-12"));
    expect(screen.getByTestId("feedback-progress").dataset.estimate).toBe("dated");
    expect(screen.queryByTestId("feedback-progress-no-date")).toBeNull();
    expect(screen.getByTestId("feedback-progress-estimate").textContent).not.toBe("Estimate");
  });

  it.each([
    ["FB-11", "untriaged", "No estimate"],
    ["FB-20", "history", "Too few landed issues (3 of 10)"],
    ["FB-14", "no_issues", "No estimate"],
    ["FB-15", "no_work", "No estimate"],
    ["FB-17", "waits", "Waits on Dana Lee"],
    ["FB-19", "ended", "No estimate"],
    ["FB-13", "release_waits", "Built; no date until Dana Lee releases it"],
  ])("%s with no date says why: %s", async (key, reason, line) => {
    await shown(CASE(key));
    const none = screen.getByTestId("feedback-progress-no-date");
    expect(none.dataset.reason).toBe(reason);
    expect(none.textContent).toContain(line);
  });

  it("names the snooze's end date rather than a bare 'no estimate'", async () => {
    await shown(CASE("FB-18"));
    const none = screen.getByTestId("feedback-progress-no-date");
    expect(none.dataset.reason).toBe("snoozed");
    expect(none.textContent).toMatch(/^Snoozed until \S/);
  });

  it("names who triages an untriaged item", async () => {
    await shown(CASE("FB-11"));
    expect(screen.getByTestId("feedback-progress").dataset.work).toBe("untriaged");
    expect(screen.getByTestId("feedback-forecast-line").textContent).toContain("A holder of feedback.approve");
  });

  it("a fixed item still unreleased waits on whoever cuts the release, linked", async () => {
    await shown(CASE("FB-13"));
    const line = screen.getByTestId("feedback-forecast-line");
    expect(line.textContent).toBe("Fixed · waits on Dana Lee to cut 0.4.0");
    expect(within(line).getByRole("link", { name: "0.4.0" }).getAttribute("href")).toBe("/projects/hop/releases/0.4.0");
  });

  it("a release a holder approves names the cut and the approval", async () => {
    const landed = CASE("FB-13");
    const delivery = landed.forecast.delivery;
    if (!delivery) throw new Error("FB-13 carries a delivery");
    const approval = {
      kind: "person" as const,
      mode: "approval" as const,
      ...forecastWait(say("standing.who.named", { name: "Dana Lee" }), say("standing.act.cutThenApprove", { v: "0.1.0" }), say("forecast.reason.approval", { holders: null })),
      version: "0.1.0",
      holders: [{ id: "u1", name: "Dana Lee", kind: "human" as const }],
    };
    await shown({ ...landed, forecast: { ...landed.forecast, delivery: { ...delivery, release: approval } } });
    const line = screen.getByTestId("feedback-forecast-line");
    expect(line.textContent).toBe("Fixed · waits on Dana Lee to cut 0.1.0, then approve it");
    expect(within(line).getByRole("link", { name: "0.1.0" }).getAttribute("href")).toBe("/projects/hop/releases/0.1.0");
  });

  it("shipped work names its release instead of an estimate", async () => {
    await shown(CASE("FB-16"));
    const shipped = screen.getByTestId("feedback-progress-shipped");
    expect(shipped.textContent).toContain("Shipped in 0.3.0");
    expect(within(shipped).getByRole("link", { name: "0.3.0" }).getAttribute("href")).toBe("/projects/hop/releases/0.3.0");
  });

  it("a duplicate follows its original, linked", async () => {
    await shown(CASE("FB-17"));
    const carriers = screen.getByTestId("feedback-progress-carriers");
    expect(within(carriers).getByRole("link", { name: "FB-3" }).getAttribute("href")).toBe("/projects/hop/feedback/FB-3");
  });

  it("a requirement carrying the item is linked with its status", async () => {
    await shown(CASE("FB-14"));
    const carriers = screen.getByTestId("feedback-progress-carriers");
    expect(within(carriers).getByRole("link", { name: "REQ-7" }).getAttribute("href")).toBe("/projects/hop/requirements/REQ-7");
  });

  it("an item nothing carries draws no carriers row", async () => {
    await shown(CASE("FB-15"));
    expect(screen.queryByTestId("feedback-progress-carriers")).toBeNull();
  });

  it("says the progress could not be read, naming why, instead of drawing nothing", async () => {
    await shown({ status: 403, body: { error: "FORBIDDEN", message: "Not a member of this project" } });
    expect(screen.getByTestId("feedback-progress-unread").textContent).toContain("Progress could not be read");
    expect(screen.queryByTestId("feedback-progress-estimate")).toBeNull();
  });
});
