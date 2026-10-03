// @vitest-environment jsdom
//
// ISS-1310 — a person at a park is offered the decision they have, not the transitions map. The
// exits below are core's own rows for these statuses (`pipeline/state-machine.ts`), so what the fold
// offers is what the map holds; since ISS-54 the way back is the status the park left.

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

/** Core's own rows (`pipeline/state-machine.ts` `transitions`): a park's way back to the status it
 *  left is not in the table, because it depends on the row (`workState.leftStatus`). */
const STATUS_EXITS = {
  needs_info: ["on_hold", "dropped"],
  on_hold: ["needs_info", "dropped"],
  in_progress: ["approved", "awaiting_release", "closed", "needs_info", "on_hold", "dropped"],
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
      status: "needs_info",
      owes: "decision",
      since: null,
      reason: null,
      resume: { at: null, why: "no record" },
      record: null,
      readings: [],
      answer: null,
      openQuestionIds: [],
      ...over,
    },
  };
}

async function openAt(
  status: IssueStatus,
  reading?: ParkReading,
  acts = actions(),
  leftStatus: IssueStatus | null = null,
) {
  get.mockResolvedValue({ version: 7, runnerCapabilities: {}, statusExits: STATUS_EXITS });
  wrap(
    <StatusEdit
      status={status}
      leftStatus={leftStatus}
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
  it("returns a park only to the status it left, never to a status it did not leave", async () => {
    await openAt("needs_info", undefined, actions(), "awaiting_release");
    expect(labels()).toContain("Awaiting release");
    expect(labels()).not.toContain("In progress");
    expect(labels()).not.toContain("Open");
  });

  it("offers every parkable status where nothing recorded the status the park left", async () => {
    await openAt("on_hold", undefined, actions(), null);
    for (const word of ["Open", "Reopened", "In progress", "Approved", "Awaiting release"]) {
      expect(labels()).toContain(word);
    }
    expect(labels()).not.toContain("Draft");
    expect(labels()).not.toContain("Closed");
  });

  it("offers Resume at Awaiting release first when the park left awaiting_release", async () => {
    const acts = await openAt(
      "needs_info",
      park({ resume: { at: "awaiting_release", recordId: null } }),
      actions(),
      "awaiting_release",
    );
    expect(labels()).toEqual(["Resume at Awaiting release", "On hold", "Dropped", "Move anyway…"]);
    fireEvent.click(screen.getByText("Resume at Awaiting release"));
    expect(acts.move).toHaveBeenCalledWith("awaiting_release");
  });

  it("orders answer, resume, not needed, set down, then the map, where a question is open", async () => {
    await openAt(
      "needs_info",
      park({
        owes: "information",
        resume: { at: "approved", recordId: null },
        openQuestionIds: ["q1"],
      }),
      actions(),
      "approved",
    );
    expect(labels()).toEqual([
      "Answer the question",
      "Resume at Approved",
      "The question is not needed any more…",
      "On hold",
      "Dropped",
      "Move anyway…",
    ]);
  });

  it("offers no resume and no not-needed where nothing says which status the park left, and says so", async () => {
    await openAt("needs_info", park({ owes: "information", openQuestionIds: ["q1"] }));
    expect(labels()).toEqual([
      "Answer the question",
      "Nothing says where this issue picks up again",
      "On hold",
      "Dropped",
      "Move anyway…",
    ]);
    expect(screen.getByText("Nothing says where this issue picks up again")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("offers Answer only where there is a question — none on a decision park without one", async () => {
    await openAt("needs_info", park({ resume: { at: "in_progress", recordId: null } }), actions(), "in_progress");
    expect(labels()).not.toContain("Answer the question");
    expect(labels()).not.toContain("The question is not needed any more…");
  });

  it("treats a needs_info park asked only in the thread as a question", async () => {
    const acts = await openAt("needs_info", park({ owes: "information", reason: "Which tenant?" }));
    fireEvent.click(screen.getByText("Answer the question"));
    expect(acts.answer).toHaveBeenCalled();
  });

  it("folds the map, the way back included, behind Move anyway", async () => {
    const acts = await openAt(
      "needs_info",
      park({ resume: { at: "in_progress", recordId: null } }),
      actions(),
      "in_progress",
    );
    fireEvent.click(screen.getByText("Move anyway…"));
    expect(acts.moveAnyway).toHaveBeenCalledWith(["in_progress", ...STATUS_EXITS.needs_info]);
  });

  it.each([
    ["loading", "Reading what this issue is waiting on…"],
    ["error", "Couldn't read what this issue is waiting on, so no resume is offered"],
  ] as const)("while the park is %s it offers no resume and says which", async (state, said) => {
    await openAt("needs_info", { state });
    expect(labels()).toEqual([said, "Move anyway…"]);
  });

  it.each([
    ["loading", "Reading what this issue is waiting on…"],
    ["error", "Couldn't read what this issue is waiting on, so no resume is offered"],
  ] as const)("says the park is %s while the map is unread too, and offers no Move anyway", async (state, said) => {
    get.mockReturnValue(new Promise(() => {}));
    wrap(<StatusEdit status="needs_info" onTransition={vi.fn()} park={{ reading: { state }, actions: actions() }} />);
    fireEvent.click(screen.getByLabelText(`Change status (currently ${statusLabel("needs_info")})`));
    expect(labels()).toEqual([said, "Loading status moves…"]);
  });

  it("offers the status the park left while the map cannot be read, and says the map failed", async () => {
    get.mockRejectedValue(new Error("down"));
    const acts = actions();
    wrap(
      <StatusEdit
        status="needs_info"
        leftStatus="in_progress"
        onTransition={vi.fn()}
        park={{ reading: park({ resume: { at: "in_progress", recordId: null } }), actions: acts }}
      />,
    );
    fireEvent.click(screen.getByLabelText(`Change status (currently ${statusLabel("needs_info")})`));
    await waitFor(() => expect(labels()).toEqual(["Resume at In progress", "Couldn't load status moves"]));
    fireEvent.click(screen.getByText("Resume at In progress"));
    expect(acts.move).toHaveBeenCalledWith("in_progress");
  });

  it("offers the status the park left where the map has no row for the park at all", async () => {
    const { needs_info: _dropped, ...withoutPark } = STATUS_EXITS;
    get.mockResolvedValue({ version: 7, runnerCapabilities: {}, statusExits: withoutPark });
    wrap(
      <StatusEdit
        status="needs_info"
        leftStatus="in_progress"
        onTransition={vi.fn()}
        park={{ reading: park({ resume: { at: "in_progress", recordId: null } }), actions: actions() }}
      />,
    );
    fireEvent.click(screen.getByLabelText(`Change status (currently ${statusLabel("needs_info")})`));
    await waitFor(() => expect(labels()).toEqual(["Resume at In progress", "Move anyway…"]));
    expect(screen.getByText("Move anyway…")).toHaveAttribute("aria-disabled", "true");
  });

  it("puts Answer above a working status's own moves when a question is open there", async () => {
    await openAt(
      "in_progress",
      park({
        shape: "question",
        status: "in_progress",
        owes: "information",
        openQuestionIds: ["q1"],
        resume: { at: null, why: "not stopped" },
      }),
    );
    const got = labels();
    expect(got[0]).toBe("Answer the question");
    expect([...got.slice(1)].sort()).toEqual(
      STATUS_EXITS.in_progress.map((to) => statusLabel(to)).sort(),
    );
    expect(got.length).toBe(1 + STATUS_EXITS.in_progress.length);
  });
});
