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
    const steps = screen.getAllByTitle(/^(drive|release_batch)$/).map((n) => n.textContent);
    expect(steps).toEqual(["Issue work", "Releases"]);
    expect(screen.getByText(/Slowest step:/)).toHaveTextContent(
      "Slowest step: Issue work at a 15m 00s median over 2 runs, 15.0× slower than Releases.",
    );
    expect(screen.getByText("3 steps · 7d")).toBeInTheDocument();
    expect(screen.queryByText("release_batch")).toBeNull();
  });

  it("names no comparison where there is only one step to compare", () => {
    mount({ durations: [duration("reconcile", 600, 1.5)] });
    expect(screen.getByText(/Slowest step:/)).toHaveTextContent(
      "Slowest step: Skill updates at a 10m 00s median over 1 run.",
    );
  });

  it("says a step no kind of work names is unrecognised, keeping the stored name as its title", () => {
    mount({ durations: [duration("code", 600, 1.5)] });
    expect(screen.getByTitle("code")).toHaveTextContent("Unrecognised work (code)");
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
