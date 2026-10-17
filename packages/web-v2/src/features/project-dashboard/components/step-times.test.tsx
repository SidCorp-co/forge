// @vitest-environment jsdom
//
// ISS-1154 — "Where time goes" on the project dashboard. Its four states each say what they are:
// loading is a skeleton and not "No steps yet", an unread window is an error with a working retry
// and not an empty one, and a window that finished nothing is its own empty state.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StepDurationRow } from "@/features/runs/types";
import { StepTimes } from "./step-times";

expect.extend(matchers);
afterEach(cleanup);

const duration = (step: string, durationSeconds: number, costUsd: number): StepDurationRow => ({
  runId: "r1",
  issueId: null,
  projectId: "p1",
  step,
  startedAt: "2026-09-21T00:00:00.000Z",
  finishedAt: "2026-09-21T00:10:00.000Z",
  durationSeconds,
  costUsd,
});

const mount = (over: Partial<Parameters<typeof StepTimes>[0]> = {}) =>
  render(
    <StepTimes durations={[]} windowDays={7} isLoading={false} error={null} onRetry={vi.fn()} {...over} />,
  );

describe("StepTimes", () => {
  it("lists each kind of work in the Overview's words with its median and cost, slowest first, and names the slowest", () => {
    mount({
      durations: [duration("drive", 600, 1.5), duration("drive", 1200, 2), duration("release_batch", 60, 0.25)],
    });
    const steps = screen.getAllByTitle(/^(Issue work|Releases)$/).map((n) => n.textContent);
    expect(steps).toEqual(["Issue work", "Releases"]);
    expect(screen.getByText(/Slowest step:/)).toHaveTextContent(
      "Slowest step: Issue work at a 15m 00s median over 2 runs, 15.0× slower than Releases.",
    );
    // ISS-1228 round 8: the header counts the steps it lists, and says what its other figure counts.
    expect(screen.getByText("2 steps · 3 finished · 7d")).toBeInTheDocument();
    expect(screen.queryByText("release_batch")).toBeNull();
  });

  it("names no comparison where there is only one step to compare", () => {
    mount({ durations: [duration("reconcile", 600, 1.5)] });
    expect(screen.getByText(/Slowest step:/)).toHaveTextContent(
      "Slowest step: Skill updates at a 10m 00s median over 1 run.",
    );
  });

  // ISS-1228 round 9 (criterion 55): a retired kind reads in words, on the row and in its title.
  // ISS-1229 round 13, the master's ruling: a step the registry no longer has reads as unrecognised.
  it("says a step the registry no longer has is unrecognised, showing its stored name, its title included", () => {
    const stored = "review_followup_rework_after_codex_consult";
    mount({ durations: [duration(stored, 600, 1.5)] });
    const label = document.querySelector<HTMLElement>("[data-step-label]");
    expect(label).toHaveTextContent(`Unrecognised work (${stored})`);
    expect(label?.title).toBe(`Unrecognised work (${stored})`);
  });

  it("says no step finished, in one flat line, when the window holds nothing", () => {
    mount();
    const line = screen.getByRole("region", { name: "Where time goes" });
    expect(line).toHaveTextContent("Where time goes·no agent step finished in 7 days");
    expect(line.className).toMatch(/\bh-10\b/);
    expect(line.className).not.toMatch(/\bshadow-sm\b|\brounded-lg\b/);
  });

  it("shows neither the empty nor the filled state while the window is loading", () => {
    mount({ isLoading: true });
    expect(screen.getByText("The step times are still being read.")).toBeInTheDocument();
    expect(screen.queryByText(/no agent step finished/)).toBeNull();
    expect(screen.queryByText(/Slowest step:/)).toBeNull();
  });

  it("refuses an unread window by name instead of calling it empty, and retries", () => {
    const onRetry = vi.fn();
    mount({ error: new Error("the step-durations read failed"), onRetry });
    expect(screen.getByText("Couldn't load step times")).toBeInTheDocument();
    expect(screen.queryByText(/no agent step finished/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("StepTimes — every step label reads whole (ISS-1228 criterion 38)", () => {
  it("wraps a label rather than clipping it, so two unrecognised steps never read alike", () => {
    mount({ durations: [duration("forge-code", 600, 1), duration("forge-test", 300, 1)] });
    const labels = [...document.querySelectorAll<HTMLElement>("[data-step-label]")];
    expect(labels.map((l) => l.textContent)).toEqual([
      "Unrecognised work (forge-code)",
      "Unrecognised work (forge-test)",
    ]);
    for (const l of labels) {
      expect(l.className).not.toMatch(/\b(truncate|line-clamp-\d|whitespace-nowrap)\b/);
      expect(l.className).toMatch(/\bbreak-words\b/);
    }
  });
});

describe("StepTimes — the header counts what it lists (ISS-1228 criterion 46)", () => {
  it("names as many steps as it draws rows, however many times each finished", () => {
    mount({
      durations: [
        duration("drive", 600, 1),
        duration("drive", 700, 1),
        duration("release_batch", 60, 0.1),
        duration("skill_check", 30, 0.1),
        duration("skill_update", 20, 0.1),
        duration("review_followup_rework_after_codex_consult", 900, 1),
        duration("review_followup_rework_after_human_feedback", 800, 1),
      ],
    });
    const listed = document.querySelectorAll("[data-step-label]").length;
    expect(listed).toBe(6);
    expect(screen.getByText(`${listed} steps · 7 finished · 7d`)).toBeInTheDocument();
  });
});
