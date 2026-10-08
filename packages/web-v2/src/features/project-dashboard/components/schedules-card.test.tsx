// @vitest-environment jsdom
//
// ISS-1163 — a schedule whose last run was skipped (a manual Run with no runner online) is not a
// schedule that never ran; the card has no chip for it and must say what happened in words.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScheduleRow } from "@/features/schedules/types";
import { SchedulesCard } from "./schedules-card";

expect.extend(matchers);
afterEach(cleanup);

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }) }));

const NOW = Date.parse("2026-09-21T12:00:00.000Z");

const row = (over: Partial<ScheduleRow>): ScheduleRow =>
  ({
    id: "s1",
    name: "Nightly",
    cron: "0 16 * * *",
    enabled: true,
    nextRunAt: "2026-09-21T16:00:00.000Z",
    lastRunAt: "2026-09-21T09:00:00.000Z",
    lastStatus: "success",
    ...over,
  }) as ScheduleRow;

describe("the upcoming schedules card", () => {
  it("says skipped for a skipped last run, never 'never run'", () => {
    render(<SchedulesCard rows={[row({ lastStatus: "skipped" })]} now={NOW} slug="forge-dev" />);
    expect(screen.getByText("skipped")).toBeInTheDocument();
    expect(screen.queryByText("never run")).toBeNull();
  });

  it("reads a status it has no chip for as its own word", () => {
    const unknown = "quarantined" as unknown as ScheduleRow["lastStatus"];
    render(<SchedulesCard rows={[row({ lastStatus: unknown })]} now={NOW} slug="forge-dev" />);
    expect(screen.getByText("quarantined")).toBeInTheDocument();
    expect(screen.queryByText("never run")).toBeNull();
  });

  it("still says never run for a schedule with no last status", () => {
    render(<SchedulesCard rows={[row({ lastStatus: null, lastRunAt: null })]} now={NOW} slug="forge-dev" />);
    expect(screen.getByText("never run")).toBeInTheDocument();
  });
});
