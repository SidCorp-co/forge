// Ops shows on its face what a person acts on (REQ-11 BC-19, BC-20): a stage reads as its word, never
// its raw key, and a run opens from the keyboard as well as the mouse. A run of a project outside the
// active organisation is not listed at all (ISS-477), so no project id reaches the face.

import type { QueryKey } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { faceWords } from "@/test/screen-face";
import { Seeded } from "@/test/vi-chrome-requirements";
import { pipelineKeys } from "../queries";
import { OpsMonitor } from "./ops-monitor";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const NOW = "2026-10-21T09:00:00.000Z";
const OUTSIDE = "9f3c1a2b-77d0-4e4e-9a51-0d6a1c2f8e10";
const health = (id: string, projectName: string) => ({
  id, projectName, projectSlug: id, throughput: 1, totalActive: 2, statusDistribution: {}, blockers: [], pendingEscalations: 0,
  avgCycleTimeDays: 1, liveRuns: 1, runnerCount: 1, spend24hUsd: 1, memberCount: 1, members: [], lastActivityAt: NOW,
});
const step = (runId: string, projectId: string, s: string) => ({ runId, issueId: null, projectId, step: s, startedAt: NOW, finishedAt: NOW, durationSeconds: 600, costUsd: 0.5 });
const SEED: [QueryKey, unknown][] = [
  [["projects"], [{ id: "p1", slug: "hop", name: "Hop Clinic API", role: "admin", orgId: null }]],
  [["projects", "health"], [health("p1", "Hop Clinic API")]],
  [pipelineKeys.stepDurations({ days: 7 }), [step("run-1", "p1", "code"), step("run-2", "p1", "release_batch"), step("run-3", OUTSIDE, "plan")]],
  [pipelineKeys.throughput({ days: 30 }), []],
];

const ops = (tab: string) => {
  window.history.replaceState(null, "", `/ops?tab=${tab}`);
  return render(<Seeded data={SEED}><OpsMonitor /></Seeded>);
};

beforeEach(() => window.history.replaceState(null, "", "/ops"));

describe("Ops names stages and projects by their words (REQ-11 BC-19)", () => {
  it("reads each stage as its word on the Progress tab, its key the tooltip", () => {
    ops("progress");
    expect(screen.getByTitle("release_batch").textContent).toBe("Release batch");
    expect(screen.queryByText("release_batch")).toBeNull();
  });

  it("reads each run's stage as its word on the Runs tab, and shows no project id", () => {
    const { container } = ops("runs");
    expect(screen.getByText("Release batch")).toBeTruthy();
    expect(screen.queryByText("release_batch")).toBeNull();
    expect(container.textContent).not.toContain(OUTSIDE.slice(0, 8));
  });

  it("stays within the first view's budget of 300 words (BC-21)", () => {
    const { container } = ops("monitor");
    expect(faceWords(container)).toBeLessThanOrEqual(300);
  });
});

describe("a run opens from the keyboard (REQ-11 BC-20)", () => {
  it("is a labelled button in its row, which opens the run", () => {
    ops("runs");
    const open = screen.getByRole("button", { name: "Open run: Hop Clinic API, Code" });
    fireEvent.click(open);
    expect(window.location.search).toContain("run=run-1");
  });
});
