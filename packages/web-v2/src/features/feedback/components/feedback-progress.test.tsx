// An item's progress, as its reader asks it: is work running and on which issues, and when it is done.
// The Estimate row stands only where there is an estimate, a date or the release that shipped it; with
// none it is dropped, never an empty ETA and never core's working of why (ISS-903). Two reasons are
// state, not working, and are the Work row's one status line where they apply: snoozed until when,
// and fixed work waiting on whoever cuts the release, linked. Whose turn it is is the banner's.

import type { FeedbackProgress as Progress } from "@forge/contracts/forecast";
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROGRESS_CASES } from "@/test/feedback-progress";
import { fakeCore, renderWithQuery } from "@/test/render";
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

  it("dates work with a forecast", async () => {
    await shown(CASE("FB-12"));
    expect(screen.getByTestId("feedback-progress").dataset.estimate).toBe("dated");
    expect(screen.getByTestId("feedback-progress-estimate").textContent).not.toBe("Estimate");
  });

  it.each([
    ["FB-11", "untriaged"],
    ["FB-20", "history"],
    ["FB-14", "no_issues"],
    ["FB-15", "no_work"],
    ["FB-17", "waits"],
    ["FB-18", "snoozed"],
    ["FB-19", "ended"],
    ["FB-13", "release_waits"],
  ])("%s with no date (%s) draws no Estimate row and none of core's working", async (key, reason) => {
    await shown(CASE(key));
    expect(screen.getByTestId("feedback-progress").dataset.estimate).toBe(reason);
    expect(screen.queryByTestId("feedback-progress-estimate")).toBeNull();
    expect(screen.queryByText(/Estimate|Too few landed issues|No estimate/)).toBeNull();
    expect(screen.getByTestId("feedback-progress-work")).toBeInTheDocument();
  });

  it.each([
    ["FB-18", "snoozed", /^Snoozed until \S/],
    ["FB-13", "release_waits", /^Fixed · waits on Dana Lee to cut 0\.4\.0$/],
    ["FB-11", "untriaged", null],
    ["FB-20", "history", null],
    ["FB-17", "waits", null],
    ["FB-12", "dated", null],
  ])("%s (%s): the Work row says its one status line only where it applies", async (key, estimate, line) => {
    await shown(CASE(key));
    expect(screen.getByTestId("feedback-progress").dataset.estimate).toBe(estimate);
    const work = screen.getByTestId("feedback-progress-work");
    if (line === null) {
      expect(within(work).queryByTestId("feedback-work-line")).toBeNull();
      return;
    }
    expect(within(work).getByTestId("feedback-work-line").textContent).toMatch(line);
    expect(screen.queryByTestId("feedback-progress-estimate"), "the line is the Work row's, not an Estimate row").toBeNull();
    if (estimate === "release_waits") expect(within(work).getByRole("link", { name: "0.4.0" }).getAttribute("href")).toBe("/projects/hop/releases/0.4.0");
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
