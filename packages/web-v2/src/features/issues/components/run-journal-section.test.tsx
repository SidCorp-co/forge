// @vitest-environment jsdom
//
// ISS-1228 round 14 — judge-36 read a just-ended run as "1m ago · 1m 49s": one time was when it
// started and the other how long it ran, and nothing said which.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunView } from "../derive";
import { RunJournalSection } from "./run-journal-section";

expect.extend(matchers);

const NOW = Date.parse("2026-10-18T12:00:00.000Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

function run(over: Partial<RunView>): RunView {
  return {
    runId: "r1",
    ordinal: 1,
    status: "cancelled",
    alongside: [],
    startedAt: at(169_000),
    finishedAt: at(60_000),
    costUsd: null,
    sessionId: null,
    reading: null,
    hold: null,
    block: null,
    runningSince: null,
    attempts: [],
    sessions: [],
    ...over,
  };
}

function line(r: RunView): string {
  render(<RunJournalSection runs={[r]} loading={false} error={null} onRetry={() => {}} />);
  return screen.getByRole("button", { name: /^Run 1/ }).textContent ?? "";
}

describe("a run's times say which is which", () => {
  it("labels when a finished run ended and how long it ran", () => {
    expect(line(run({}))).toContain("Ended 1m ago · ran 1m 49s");
  });

  it("labels when a run still going started, and says no length for it", () => {
    const text = line(run({ status: "running", reading: "running", finishedAt: null, startedAt: at(180_000) }));
    expect(text).toContain("Started 3m ago");
    expect(text).not.toMatch(/ran /);
  });

  it("names an open run nothing lives on Nothing working, the word its drawer reads, never Running", () => {
    const text = line(run({ status: "running", reading: null, finishedAt: null, startedAt: at(20 * 60_000) }));
    expect(text).toContain("Nothing working");
    expect(text).not.toContain("Running");
  });

  it("names a run whose job stopped on a standing question Needs an answer, the word its drawer reads, never Failed", () => {
    const text = line(run({ status: "failed", reading: "asking" }));
    expect(text).toContain("Needs an answer");
    expect(text).not.toContain("Failed");
  });
});
