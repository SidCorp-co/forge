// @vitest-environment jsdom
//
// ISS-1229 r25, the master's read of the after-shots: with no issue run in the window "Is it alive?"
// drew a flat rule and an empty band beneath it. It says in words what is absent instead.

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PulseLiveness } from "../types";
import { LivenessBand } from "./liveness-band";

vi.mock("next/link", () => ({ default: ({ children }: { children: ReactNode }) => <a href="/">{children}</a> }));

afterEach(cleanup);

const liveness = (runs: number[]): PulseLiveness => ({
  jobsRunning: 0,
  jobsQueued: 0,
  jobsHeld: 0,
  liveJobs: { total: 0, shown: [] },
  stuckRuns: { total: 0, shown: [] },
  lastJobAt: null,
  silenceSeconds: null,
  heartbeat: runs.map((issueRuns, i) => ({ date: `2026-10-${String(i + 1).padStart(2, "0")}`, issueRuns })),
  devices: { online: 0, draining: 0, total: 1 },
});
const thresholds = { warnSeconds: 3600, alarmSeconds: 7200 } as never;

describe("Is it alive?", () => {
  it("says no issue run started rather than drawing an empty trace", () => {
    render(<LivenessBand liveness={liveness([0, 0, 0, 0, 0, 0, 0])} thresholds={thresholds} />);
    expect(screen.getByTestId("heartbeat-none").textContent).toMatch(/^No issue run started in the last 7 days/);
    expect(document.querySelector("svg[role=img]")).toBeNull();
  });

  it("draws the trace once any day ran an issue", () => {
    render(<LivenessBand liveness={liveness([0, 2, 0, 1, 0, 0, 3])} thresholds={thresholds} />);
    expect(screen.queryByTestId("heartbeat-none")).toBeNull();
    expect(document.querySelector("svg[role=img]")?.getAttribute("aria-label")).toMatch(/Busiest day: 3 runs/);
  });
});
