// @vitest-environment jsdom
//
// ISS-853 asked for a fixture rather than a live specimen: the condition — a
// run paused with the issue's own status untouched — is not reproducible on
// demand on this deployment, so the paused `BlockerState` is built here and the
// banner is asserted against it.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveBlockerState } from "../derive";
import type { PipelineHealth } from "../types";
import { BlockerBanner } from "./blocker-banner";

expect.extend(matchers);
afterEach(cleanup);

function pausedHealth(
  over: Partial<NonNullable<PipelineHealth["pausedRun"]>> = {},
): PipelineHealth {
  return {
    stage: "approved",
    pausedRun: {
      runId: over.runId ?? "run-1",
      pauseReason: over.pauseReason ?? null,
      kind: over.kind ?? null,
      detail: over.detail ?? null,
      resumer: over.resumer ?? "operator",
      since: over.since ?? "2026-09-06T10:00:00.000Z",
    },
  };
}

function renderPaused(
  over: Partial<NonNullable<PipelineHealth["pausedRun"]>> = {},
  onResumeRun = vi.fn(),
) {
  const blocker = deriveBlockerState(
    { status: "approved" },
    pausedHealth(over),
    undefined,
  );
  if (!blocker) throw new Error("a paused run must produce a blocker state");
  render(
    <BlockerBanner
      blocker={blocker}
      slug="forge-dev"
      pending={false}
      onApprove={vi.fn()}
      onResume={vi.fn()}
      onResumeRun={onResumeRun}
      onProvideInfo={vi.fn()}
    />,
  );
  return { blocker, onResumeRun };
}

describe("BlockerBanner — a paused run on an issue that looks healthy", () => {
  it("says the run is paused and who ends it", () => {
    renderPaused();
    expect(screen.getByText(/paused/i)).toBeInTheDocument();
    expect(screen.getByText(/Resume the run/i)).toBeInTheDocument();
  });

  it("resumes the run this issue is actually under, by id", () => {
    const onResumeRun = vi.fn();
    renderPaused({ runId: "run-42" }, onResumeRun);
    fireEvent.click(screen.getByRole("button", { name: /resume run/i }));
    expect(onResumeRun).toHaveBeenCalledWith("run-42");
  });

  // cm:guard no button for a pause the sweeper frees — offering Resume there asks an operator to do work a sweep is about to do anyway, and a surface that asks for pointless action is the one whose next real ask gets ignored
  it("offers no resume for a pause a person does not clear", () => {
    renderPaused({ resumer: "sweeper", kind: "missing_skill", detail: "open" });
    expect(screen.queryByRole("button", { name: /resume run/i })).toBeNull();
  });

  it("names the kind holding it when there is one to name", () => {
    renderPaused({
      pauseReason: "stage_stalled:code",
      kind: "stage_stalled",
      detail: "code",
    });
    expect(screen.getByText(/stage_stalled/)).toBeInTheDocument();
  });
});
