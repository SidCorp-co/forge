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
  sessionFailures: [
    { reason: "runner_unreachable", count: 4 },
    { reason: "no_client_ack", count: 2 },
    { reason: "unclassified", count: 1 },
  ],
  pipelineFlow: [
    { type: "drive", count: 9, medianSeconds: 600 },
    { type: "reconcile", count: 5, medianSeconds: 60 },
    { type: "release_batch", count: 3, medianSeconds: 300 },
    { type: "verify_skill", count: 2, medianSeconds: 120 },
  ],
} as unknown as PulseQuality;

describe("QualitySection", () => {
  it("draws no fix-against-code tile", () => {
    render(<QualitySection quality={quality} />);
    expect(screen.queryByText("Fix jobs against code jobs")).toBeNull();
    expect(screen.getByText("Closed with merge evidence")).toBeInTheDocument();
  });

  it("marks no pipeline-flow row as looping back, whatever its type", () => {
    render(<QualitySection quality={{ ...quality, pipelineFlow: [{ type: "fix", count: 2, medianSeconds: 120 }] }} />);
    expect(screen.getByText("Unrecognised work (fix)")).toBeInTheDocument();
    expect(screen.queryByText(/loops back/)).toBeNull();
  });
});

// ISS-1229 round 5 — judge-15 read this section as a stage table printing stored codes.
describe("QualitySection, in the words a reader uses", () => {
  it("heads the work table by kind of work, not by stage", () => {
    render(<QualitySection quality={quality} />);
    expect(screen.getByRole("columnheader", { name: "Work" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Stage" })).toBeNull();
    expect(screen.getByRole("img").getAttribute("aria-label")).not.toMatch(/stage/i);
  });

  it("names each kind of work the way a reader says it, never its stored type", () => {
    const { container } = render(<QualitySection quality={quality} />);
    for (const label of ["Issue work", "Skill updates", "Releases", "Skill checks"]) {
      expect(screen.getByRole("cell", { name: label })).toBeInTheDocument();
    }
    expect(container.textContent).not.toMatch(/\b(?:drive|release_batch|verify_skill|reconcile)\b/);
  });

  it("names a kind this build does not know as unrecognised, the one place its stored type shows", () => {
    render(<QualitySection quality={{ ...quality, pipelineFlow: [{ type: "future_kind", count: 1, medianSeconds: 30 }] }} />);
    expect(screen.getByRole("cell", { name: "Unrecognised work (future_kind)" })).toBeInTheDocument();
  });

  it("names each session failure by its cause, never its stored code", () => {
    const { container } = render(<QualitySection quality={quality} />);
    expect(screen.getByText("Runner unreachable")).toBeInTheDocument();
    expect(screen.getByText("No acknowledgement")).toBeInTheDocument();
    expect(screen.getByText("Unclassified")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/runner_unreachable|no_client_ack/);
  });

  it("draws no line joining one kind of work to the next", () => {
    const { container } = render(<QualitySection quality={quality} />);
    expect(container.querySelectorAll("svg line")).toHaveLength(0);
  });
});
