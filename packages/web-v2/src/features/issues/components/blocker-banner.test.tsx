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
import type { IssuePark, PipelineHealth } from "../types";
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
      onResumePark={vi.fn()}
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

describe("BlockerBanner — an issue parked for information", () => {
  it("points at the decision below rather than the comment thread", () => {
    const blocker = deriveBlockerState({ status: "needs_info" }, undefined, undefined, askedInfo());
    if (!blocker) throw new Error("needs_info must produce a blocker state");
    render(
      <BlockerBanner
        blocker={blocker}
        slug="forge-dev"
        pending={false}
        onResumePark={vi.fn()}
        onResumeRun={vi.fn()}
        onProvideInfo={vi.fn()}
      />,
    );

    expect(screen.getByText(/the question is below/i)).toBeInTheDocument();
    expect(screen.queryByText(/comment/i)).toBeNull();
  });

  it("hands the Provide info CTA to its caller", () => {
    const onProvideInfo = vi.fn();
    const blocker = deriveBlockerState({ status: "needs_info" }, undefined, undefined, askedInfo());
    if (!blocker) throw new Error("needs_info must produce a blocker state");
    render(
      <BlockerBanner
        blocker={blocker}
        slug="forge-dev"
        pending={false}
        onResumePark={vi.fn()}
        onResumeRun={vi.fn()}
        onProvideInfo={onProvideInfo}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /answer it/i }));
    expect(onProvideInfo).toHaveBeenCalled();
  });
});

function parked(over: Partial<IssuePark>) {
  return {
    state: "ready" as const,
    park: {
      shape: "park" as const,
      status: "needs_info" as const,
      owes: "information" as const,
      since: null,
      reason: null,
      resume: { at: null, why: "no record" },
      record: null,
      readings: [],
      answer: null,
      openQuestionIds: [],
      ...over,
    },
  };
}

function askedInfo() {
  return parked({ reason: "Which tenant is this for?" });
}

describe("BlockerBanner — a park resumes where it stopped (ISS-1310, ISS-54)", () => {
  it("resumes sid-desk ISS-529's shape at the status the park left, and offers no Approve", () => {
    const onResumePark = vi.fn();
    const blocker = deriveBlockerState(
      { status: "needs_info" },
      undefined,
      undefined,
      parked({ owes: "decision", resume: { at: "awaiting_release", recordId: null } }),
    );
    if (!blocker) throw new Error("a needs_info park must produce a blocker state");
    render(
      <BlockerBanner
        blocker={blocker}
        slug="sid-desk"
        pending={false}
        onResumePark={onResumePark}
        onResumeRun={vi.fn()}
        onProvideInfo={vi.fn()}
      />,
    );
    expect(screen.getByText(/waiting for a decision/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Resume at Awaiting release" }));
    expect(onResumePark).toHaveBeenCalledWith("awaiting_release");
  });

  it("resumes a hold at the status it left, never by reopening it", () => {
    const onResumePark = vi.fn();
    const blocker = deriveBlockerState(
      { status: "on_hold", workState: { leftStatus: "approved" } },
      undefined,
      undefined,
    );
    if (!blocker) throw new Error("on_hold must produce a blocker state");
    render(
      <BlockerBanner
        blocker={blocker}
        slug="forge-dev"
        pending={false}
        onResumePark={onResumePark}
        onResumeRun={vi.fn()}
        onProvideInfo={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /reopen/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Resume at Approved" }));
    expect(onResumePark).toHaveBeenCalledWith("approved");
  });

  it("offers no button on a hold that recorded no status it left", () => {
    const blocker = deriveBlockerState({ status: "on_hold", workState: null }, undefined, undefined);
    if (!blocker) throw new Error("on_hold must produce a blocker state");
    render(
      <BlockerBanner
        blocker={blocker}
        slug="forge-dev"
        pending={false}
        onResumePark={vi.fn()}
        onResumeRun={vi.fn()}
        onProvideInfo={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/status menu/i)).toBeInTheDocument();
  });
});
