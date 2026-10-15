// @vitest-environment jsdom
//
// ISS-1133 — the issue page's one view of what a run did: runs newest first, the newest open, each
// attempt with the handoff it left, drawn flat with hairlines and no card.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunView } from "../derive";
import { RunJournalSection } from "./run-journal-section";

expect.extend(matchers);
afterEach(cleanup);

const attempt = (
  phase: string,
  over: Partial<RunView["attempts"][number]> = {},
): RunView["attempts"][number] => ({
  key: `${phase}#1`,
  phase,
  attempt: 1,
  numbered: false,
  state: "done",
  durationSeconds: 75,
  summary: null,
  handoff: null,
  artifact: null,
  startedAt: "2026-10-15T07:00:00.000Z",
  endedAt: "2026-10-15T07:01:15.000Z",
  handoffAt: null,
  ...over,
});

const run = (ordinal: number, over: Partial<RunView> = {}): RunView => ({
  runId: `r${ordinal}`,
  ordinal,
  status: "completed",
  alongside: [],
  startedAt: "2026-10-15T07:00:00.000Z",
  finishedAt: "2026-10-15T07:30:00.000Z",
  costUsd: null,
  attempts: [],
  sessions: [],
  ...over,
});

const draw = (runs: RunView[], extra: Partial<Parameters<typeof RunJournalSection>[0]> = {}) =>
  render(<RunJournalSection runs={runs} loading={false} error={null} onRetry={vi.fn()} {...extra} />);

const runButton = (n: number) => screen.getByRole("button", { name: new RegExp(`Run ${n}\\b`) });

describe("RunJournalSection", () => {
  it("opens the newest run and leaves an older one closed, saying how many phases it holds", () => {
    draw([
      run(2, { status: "running", finishedAt: null, attempts: [attempt("drive", { state: "running", durationSeconds: null })] }),
      run(1, { status: "failed", attempts: [attempt("plan"), attempt("code", { state: "failed" })] }),
    ]);
    expect(runButton(2)).toHaveAttribute("aria-expanded", "true");
    expect(runButton(1)).toHaveAttribute("aria-expanded", "false");
    expect(runButton(1)).toHaveTextContent("2 phases");
    expect(screen.getByRole("list", { name: "Run 2 phases" })).toHaveTextContent("drive");
    expect(screen.queryByRole("list", { name: "Run 1 phases" })).toBeNull();

    fireEvent.click(runButton(1));
    expect(within(screen.getByRole("list", { name: "Run 1 phases" })).getByText("Failed")).toBeInTheDocument();
  });

  it("shows the run's status, span and cost on its heading line", () => {
    draw([run(1, { costUsd: 1.5 })]);
    expect(runButton(1)).toHaveTextContent("Completed");
    expect(runButton(1)).toHaveTextContent("30m 00s");
    expect(runButton(1)).toHaveTextContent("$1.50");
  });

  it("says a run recorded no phase rather than drawing nothing", () => {
    draw([run(1)]);
    expect(screen.getByText("This run recorded no phase.")).toBeInTheDocument();
  });

  it("reads an attempt with no span as a dash, never as zero", () => {
    draw([run(1, { attempts: [attempt("code", { durationSeconds: null, handoff: { step: "code" } })] })]);
    const list = screen.getByRole("list", { name: "Run 1 phases" });
    expect(list).toHaveTextContent("—");
    expect(list).not.toHaveTextContent("0s");
  });

  it("opens an attempt onto the handoff it left, field by field, with the raw handoff behind a toggle", () => {
    const handoff = { step: "drive", schema_version: 1, summary: "pushed the branch", files: [{ path: "a.ts" }, "b.ts"] };
    draw([run(1, { attempts: [attempt("drive", { summary: "pushed the branch", handoff, handoffAt: "2026-10-15T07:01:00.000Z" })] })]);
    const row = screen.getByRole("button", { name: /drive/ });
    fireEvent.click(row);
    expect(screen.getByText("files")).toBeInTheDocument();
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.queryByText("schema_version")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Raw handoff" }));
    expect(screen.getByText(/"schema_version": 1/)).toBeInTheDocument();
  });

  it("names an open attempt on an ended run as left open", () => {
    draw([run(1, { attempts: [attempt("review", { state: "left-open", durationSeconds: null })] })]);
    expect(screen.getByText("Left open")).toBeInTheDocument();
  });

  it("lists the sessions that ran a run and whether each resumed", () => {
    draw([
      run(1, {
        attempts: [attempt("plan")],
        sessions: [
          { id: "s1", jobType: "plan", continuity: "fresh", freshReason: "first-in-group", deviceName: "box-1", deviceShort: "d1" },
          { id: "s2", jobType: "code", continuity: "resumed", freshReason: null, deviceName: "box-1", deviceShort: "d1" },
        ] as unknown as RunView["sessions"],
      }),
    ]);
    expect(screen.getByText(/fresh session on box-1/)).toBeInTheDocument();
    expect(screen.getByText(/resumed on box-1/)).toBeInTheDocument();
  });

  it("is drawn flat: a hairline above, no card around it or around a run", () => {
    draw([run(1, { attempts: [attempt("plan")] })]);
    const section = screen.getByRole("region", { name: "Runs" });
    expect(section.className.split(/\s+/)).toContain("border-t");
    for (const el of [section, ...section.querySelectorAll("li")]) {
      expect(el.className).not.toMatch(/\bshadow-sm\b|\brounded-lg\b|\bbg-surface\b/);
    }
  });

  it("says the runs could not be loaded and offers a retry", () => {
    const onRetry = vi.fn();
    draw([], { error: new Error("boom"), onRetry });
    expect(screen.getByRole("region", { name: "Runs" })).toHaveTextContent("Couldn't load");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("says a group run is shared, and with which issues", () => {
    draw([run(1, { alongside: ["ISS-9", "ISS-12"] })]);
    expect(runButton(1)).toHaveTextContent("with ISS-9, ISS-12");
  });
});
