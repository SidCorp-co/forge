// @vitest-environment jsdom
//
// ISS-1229 — the quality section draws no fix-against-code tile and marks no row as a loop: both
// would read staged job types no door mints.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PulseQuality } from "../types";
import { QualitySection } from "./quality-section";

expect.extend(matchers);
afterEach(cleanup);

const quality = {
  finished: { merged: 3, closedUnmerged: 1, dropped: 1 },
  reopened: { issues: 1, events: 2 },
  runFailure: {
    pipeline: { failed: 0, total: 2 },
    scheduler: { failed: 0, total: 0 },
    other: { failed: 0, total: 0 },
  },
  sessionFailures: [],
  pipelineFlow: [
    { type: "reconcile", count: 5, medianSeconds: 60 },
    { type: "fix", count: 2, medianSeconds: 120 },
  ],
} as unknown as PulseQuality;

describe("QualitySection", () => {
  it("draws no fix-against-code tile", () => {
    render(<QualitySection quality={quality} />);
    expect(screen.queryByText("Fix jobs against code jobs")).toBeNull();
    expect(screen.getByText("Closed with merge evidence")).toBeInTheDocument();
  });

  it("marks no pipeline-flow row as looping back, whatever its type", () => {
    render(<QualitySection quality={quality} />);
    expect(screen.getByText("fix")).toBeInTheDocument();
    expect(screen.queryByText(/loops back/)).toBeNull();
  });
});
