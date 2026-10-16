// @vitest-environment jsdom
//
// ISS-1228 criterion 38 — the 7-day spend's legend names each kind of work whole. At 1280 the card is
// a narrow column of the dashboard, and two labels sharing an opening ("Unrecognised work (…)") were
// clipped to the same words, so which colour was which could only be read by hovering.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { StepDurationRow } from "@/features/runs/types";
import { spendByStep } from "../derive";
import { SpendCard } from "./spend-card";

expect.extend(matchers);
afterEach(cleanup);

const row = (step: string, costUsd: number): StepDurationRow => ({
  runId: "r1",
  issueId: null,
  projectId: "p1",
  step,
  startedAt: "2026-10-15T00:00:00.000Z",
  finishedAt: "2026-10-15T00:10:00.000Z",
  durationSeconds: 600,
  costUsd,
});

describe("the 7-day spend legend", () => {
  it("shows every label whole, wrapping instead of clipping, so no two read alike", () => {
    const data = spendByStep([row("forge-code", 3), row("forge-test", 2), row("drive", 1)]);
    render(<SpendCard data={data} inFlightUsd={0} read={{ read: "ok" }} />);
    const labels = [...document.querySelectorAll<HTMLElement>("[data-spend-label]")];
    expect(labels.map((l) => l.textContent)).toEqual([
      "Unrecognised work (forge-code)",
      "Unrecognised work (forge-test)",
      "Issue work",
    ]);
    for (const l of labels) {
      expect(l.className).not.toMatch(/\b(truncate|line-clamp-\d|whitespace-nowrap)\b/);
      expect(l.className).toMatch(/\bbreak-words\b/);
    }
  });
});
