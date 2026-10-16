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
    expect(labels.map((l) => l.textContent)).toEqual(["Forge code", "Forge test", "Issue work"]);
    for (const l of labels) {
      expect(l.className).not.toMatch(/\b(truncate|line-clamp-\d|whitespace-nowrap)\b/);
      expect(l.className).toMatch(/\bbreak-words\b/);
      expect(l.className).not.toMatch(/\bbreak-all\b/);
    }
  });

  // ISS-1228 round 9 (criteria 55, 56): a retired kind still in the window reads in words, so its
  // label breaks between them at 390 rather than through a stored name with no spaces.
  it("names a retired kind in words, with no stored name anywhere on the card", () => {
    const stored = "review_followup_rework_after_codex_consult";
    const data = spendByStep([row(stored, 3), row("triage", 2)]);
    const { container } = render(<SpendCard data={data} inFlightUsd={0} read={{ read: "ok" }} />);
    const labels = [...document.querySelectorAll<HTMLElement>("[data-spend-label]")].map((l) => l.textContent);
    expect(labels).toEqual(["Review followup rework after codex consult", "Triage"]);
    expect(container.innerHTML).not.toContain(stored);
    expect(container.innerHTML).not.toContain("Unrecognised");
  });
});
