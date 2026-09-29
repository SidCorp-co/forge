// @vitest-environment jsdom
//
// ISS-1310 — a person at a park is offered the decision they have, not the transitions map. The
// exits below are core's own rows for these rungs (`pipeline/state-machine.ts`), so what the fold
// offers is what the map holds.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/providers/toast-provider";
import type { ParkReading } from "../derive";
import { statusLabel } from "../derive";
import type { ParkMenuActions } from "../park";
import type { IssuePark, IssueStatus } from "../types";
import { StatusEdit } from "./inline-edit-cell";

expect.extend(matchers);

const get = vi.fn();
vi.mock("../registry-api", () => ({ registryApi: { get: () => get() } }));

const STATUS_EXITS = {
  waiting: ["open", "in_progress", "needs_info", "on_hold", "dropped"],
  needs_info: [
    "open",
    "confirmed",
    "approved",
    "in_progress",
    "developed",
    "testing",
    "awaiting_release",
    "on_hold",
    "dropped",
  ],
  testing: ["awaiting_release", "closed", "reopen", "needs_info", "on_hold", "dropped"],
} as const;

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

function actions(): ParkMenuActions & { [k: string]: ReturnType<typeof vi.fn> } {
  return { answer: vi.fn(), move: vi.fn(), notNeeded: vi.fn(), moveAnyway: vi.fn() };
}

function park(over: Partial<IssuePark>): ParkReading {
  return {
    state: "ready",
    park: {
      shape: "park",
      status: "waiting",
      owes: "decision",
      since: null,
      reason: null,
      resume: { at: null, why: "no record" },
      record: null,
      readings: [],
      openQuestionIds: [],
      ...over,
    },
  };
}

async function openAt(status: IssueStatus, reading?: ParkReading, acts = actions()) {
  get.mockResolvedValue({ version: 7, runnerCapabilities: {}, statusExits: STATUS_EXITS });
  wrap(
    <StatusEdit
      status={status}
      onTransition={vi.fn()}
      park={reading ? { reading, actions: acts } : undefined}
    />,
  );
  fireEvent.click(screen.getByLabelText(`Change status (currently ${statusLabel(status)})`));
  await waitFor(() => expect(labels()).not.toContain("Loading status moves…"));
  return acts;
}

const labels = () => screen.getAllByRole("menuitem").map((el) => el.textContent ?? "");

afterEach(() => {
  cleanup();
  get.mockReset();
});

describe("the status control at a park (ISS-1310)", () => {
  it("reproduces ISS-529 today: the map alone does not offer developed at waiting", async () => {
    await openAt("waiting");
    expect(labels()).not.toContain("Developed");
    expect(labels()).not.toContain("Resume at Developed");
  });

  it("offers Resume at Developed first when the park recorded developed", async () => {
    const acts = await openAt(
      "waiting",
      park({ resume: { at: "developed", recordId: "c1" } }),
    );
    expect(labels()).toEqual(["Resume at Developed", "On hold", "Dropped", "Move anyway…"]);
    fireEvent.click(screen.getByText("Resume at Developed"));
    expect(acts.move).toHaveBeenCalledWith("developed");
  });

  it("orders answer, resume, not needed, set down, then the map, where a question is open", async () => {
    await openAt(
      "needs_info",
      park({
        status: "needs_info",
        owes: "information",
        resume: { at: "confirmed", recordId: "c1" },
        openQuestionIds: ["q1"],
      }),
    );
    expect(labels()).toEqual([
      "Answer the question",
      "Resume at Confirmed",
      "The question is not needed any more…",
      "On hold",
      "Dropped",
      "Move anyway…",
    ]);
  });

  it("offers no resume and no not-needed where the park recorded no rung, and says so", async () => {
    await openAt(
      "needs_info",
      park({ status: "needs_info", owes: "information", openQuestionIds: ["q1"] }),
    );
    expect(labels()).toEqual([
      "Answer the question",
      "No resume rung was recorded for this park",
      "On hold",
      "Dropped",
      "Move anyway…",
    ]);
    expect(screen.getByText("No resume rung was recorded for this park")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("offers Answer only where there is a question — none on a waiting park without one", async () => {
    await openAt("waiting", park({ resume: { at: "developed", recordId: "c1" } }));
    expect(labels()).not.toContain("Answer the question");
    expect(labels()).not.toContain("The question is not needed any more…");
  });

  it("treats a needs_info park asked only in the thread as a question", async () => {
    const acts = await openAt(
      "needs_info",
      park({ status: "needs_info", owes: "information", reason: "Which tenant?" }),
    );
    fireEvent.click(screen.getByText("Answer the question"));
    expect(acts.answer).toHaveBeenCalled();
  });

  it("folds the unchanged map behind Move anyway", async () => {
    const acts = await openAt("waiting", park({ resume: { at: "developed", recordId: "c1" } }));
    fireEvent.click(screen.getByText("Move anyway…"));
    expect(acts.moveAnyway).toHaveBeenCalledWith([...STATUS_EXITS.waiting]);
  });

  it.each([
    ["loading", "Reading what this park waits on…"],
    ["error", "Couldn't read what this park waits on, so no resume rung is offered"],
  ] as const)("while the park is %s it offers no resume and says which", async (state, said) => {
    await openAt("waiting", { state });
    expect(labels()).toEqual([said, "Move anyway…"]);
  });

  it.each([
    ["loading", "Reading what this park waits on…"],
    ["error", "Couldn't read what this park waits on, so no resume rung is offered"],
  ] as const)("says the park is %s while the map is unread too, and offers no Move anyway", async (state, said) => {
    get.mockReturnValue(new Promise(() => {}));
    wrap(<StatusEdit status="waiting" onTransition={vi.fn()} park={{ reading: { state }, actions: actions() }} />);
    fireEvent.click(screen.getByLabelText(`Change status (currently ${statusLabel("waiting")})`));
    expect(labels()).toEqual([said, "Loading status moves…"]);
  });

  it("offers the recorded rung while the map cannot be read, and says the map failed", async () => {
    get.mockRejectedValue(new Error("down"));
    const acts = actions();
    wrap(
      <StatusEdit
        status="waiting"
        onTransition={vi.fn()}
        park={{ reading: park({ resume: { at: "developed", recordId: "c1" } }), actions: acts }}
      />,
    );
    fireEvent.click(screen.getByLabelText(`Change status (currently ${statusLabel("waiting")})`));
    await waitFor(() => expect(labels()).toEqual(["Resume at Developed", "Couldn't load status moves"]));
    fireEvent.click(screen.getByText("Resume at Developed"));
    expect(acts.move).toHaveBeenCalledWith("developed");
  });

  it("offers the recorded rung where the map has no move from the park at all", async () => {
    get.mockResolvedValue({ version: 7, runnerCapabilities: {}, statusExits: { ...STATUS_EXITS, waiting: [] } });
    wrap(
      <StatusEdit
        status="waiting"
        onTransition={vi.fn()}
        park={{ reading: park({ resume: { at: "developed", recordId: "c1" } }), actions: actions() }}
      />,
    );
    fireEvent.click(screen.getByLabelText(`Change status (currently ${statusLabel("waiting")})`));
    await waitFor(() => expect(labels()).toEqual(["Resume at Developed", "Move anyway…"]));
    expect(screen.getByText("Move anyway…")).toHaveAttribute("aria-disabled", "true");
  });

  it("puts Answer above a working rung's own moves when a question is open there", async () => {
    await openAt(
      "testing",
      park({
        shape: "question",
        status: "testing",
        owes: "information",
        openQuestionIds: ["q1"],
        resume: { at: null, why: "not stopped" },
      }),
    );
    const got = labels();
    expect(got[0]).toBe("Answer the question");
    expect([...got.slice(1)].sort()).toEqual(
      STATUS_EXITS.testing.map((to) => statusLabel(to)).sort(),
    );
    expect(got.length).toBe(1 + STATUS_EXITS.testing.length);
  });
});
