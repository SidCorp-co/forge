// @vitest-environment jsdom
//
// Shape & release said "A release cannot start now: 2 things stop it" while the release gate offered
// Release now for a ready issue: it counted the roster's per-issue reasons, not what can be picked
// (ISS-1421 r40, judge-164). The answer now reads the gate's own pick rule.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReleaseReadiness } from "../types";

expect.extend(matchers);

const readiness = vi.fn();
const roster = vi.fn();
vi.mock("../hooks", async (importActual) => {
  const actual = await importActual<typeof import("../hooks")>();
  return { ...actual, useReleaseReadiness: () => readiness() };
});
vi.mock("@/features/issues/hooks", async (importActual) => {
  const actual = await importActual<typeof import("@/features/issues/hooks")>();
  return { ...actual, useReleaseRoster: () => roster() };
});

const { ReleaseAnswer } = await import("./release-section");

afterEach(cleanup);

const blocker = (code: string, reader: string) => ({ code, message: reader, reader, details: {} });

/** Two per-issue reasons, as judge-164 met them: two notes missing and one issue not marked merged. */
const TWO_PER_ISSUE = [
  blocker("RELEASE_RECORD_MISSING", "2 issues named here (ISS-2, ISS-1) have no release note."),
  blocker("RELEASE_WORK_UNMERGED", "1 issue named here (ISS-4) is not marked merged."),
];

function readinessWith(blockers: unknown[]): ReleaseReadiness {
  return {
    hasReleaseGate: true,
    releaseChain: [{ branch: "main" }],
    releaseModel: "publish",
    releaseStrategy: null,
    baseBranch: "main",
    liveBranch: null,
    targetUndeclared: false,
    providers: ["coolify"],
    releaseRunnerLabel: null,
    rollback: null,
    rollbackMode: null,
    hasVerify: true,
    verifySources: [],
    declarationRead: true,
    channelsRead: true,
    blockers,
    warnings: [],
    gaps: [],
    carried: null,
  } as unknown as ReleaseReadiness;
}

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  displayId: id,
  claimedByRunId: null,
  closeRefusals: [],
  releaseRefusals: [],
  closeFailure: null,
  ...over,
});
const NOT_MERGED = { closeRefusals: [{ code: "CLOSE_REQUIRES_SHIPPED", reason: "not marked merged" }] };
const NO_NOTE = { releaseRefusals: [{ code: "RELEASE_RECORD_MISSING", said: "no note", saidHere: "no note" }] };

function draw(blockers: unknown[], gate: unknown) {
  readiness.mockReturnValue({ isLoading: false, isError: false, data: readinessWith(blockers) });
  roster.mockReturnValue({ data: gate });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ReleaseAnswer projectId="p-1" slug="desk" />
    </QueryClientProvider>,
  );
  return screen.getByTestId("release-answer").querySelector("p")?.textContent ?? "";
}

describe("Shape & release's answer, beside the release gate", () => {
  it("says a release can start for the ready issue where the gate offers Release now for it", () => {
    const said = draw(TWO_PER_ISSUE, {
      gateStatus: "awaiting_release",
      blockingAll: [],
      issues: [row("ISS-1", NO_NOTE), row("ISS-2", NO_NOTE), row("ISS-3"), row("ISS-4", NOT_MERGED)],
    });
    expect(said).toContain("A release can start now for the one issue ready to release; 2 things keep the others out of it.");
    expect(said).not.toMatch(/cannot start/);
  });

  it("counts every issue the gate offers", () => {
    const said = draw(TWO_PER_ISSUE, {
      gateStatus: "awaiting_release",
      blockingAll: [],
      issues: [row("ISS-1", NO_NOTE), row("ISS-3"), row("ISS-5")],
    });
    expect(said).toContain("A release can start now for the 2 issues ready to release;");
  });

  it("says a release cannot start where the gate offers Release now for no issue", () => {
    const said = draw(TWO_PER_ISSUE, {
      gateStatus: "awaiting_release",
      blockingAll: [],
      issues: [row("ISS-1", NO_NOTE), row("ISS-4", NOT_MERGED)],
    });
    expect(said).toContain("A release cannot start now: 2 things stop it.");
  });

  it("says a release cannot start where a reason no pick escapes holds every issue", () => {
    const said = draw([blocker("NO_RUNNER_ONLINE", "No runner is online.")], {
      gateStatus: "awaiting_release",
      blockingAll: [{ code: "NO_RUNNER_ONLINE", said: "No runner is online.", runId: null }],
      issues: [row("ISS-3")],
    });
    expect(said).toContain("A release cannot start now: 1 thing stops it.");
  });

  it("says what it said before where the gate could not be read", () => {
    const said = draw(TWO_PER_ISSUE, undefined);
    expect(said).toContain("A release cannot start now: 2 things stop it.");
  });
});
