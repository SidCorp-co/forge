// @vitest-environment jsdom
//
// ISS-1251 round 4 — a bulk hold asks for one reason for the whole selection. The bar offers On
// hold again, opens the reason dialog once naming how many issues it covers, sends nothing until a
// reason is typed, and sends that reason with the one bulk update.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/providers/toast-provider";
import type { IssueRow } from "../types";
import { BulkActionBar } from "./bulk-action-bar";

expect.extend(matchers);

const get = vi.fn();
const mutate = vi.fn();
let pending = false;

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }) }));
vi.mock("../registry-api", () => ({ registryApi: { get: () => get() } }));
vi.mock("../hooks", async () => {
  const actual = await vi.importActual<typeof import("../hooks")>("../hooks");
  return { ...actual, useBulkUpdateIssues: () => ({ mutate, isPending: pending }) };
});

const EXITS = {
  open: ["confirmed", "in_progress", "needs_info", "on_hold", "dropped"],
  in_progress: ["developed", "closed", "needs_info", "on_hold", "dropped"],
  closed: ["reopen"],
} as const;

const row = (over: Partial<IssueRow>): IssueRow =>
  ({ id: "i1", issueId: "ISS-1", displayId: "ISS-1", title: "t", status: "open", priority: "medium", ...over }) as IssueRow;

function bar(rows: IssueRow[], onCleared = vi.fn(), canRelease = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (ui: ReactNode) => (
    <QueryClientProvider client={qc}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>
  );
  render(wrap(<BulkActionBar projectId="p1" selectedRows={rows} onCleared={onCleared} canRelease={canRelease} />));
  return { onCleared };
}

const setStatus = () => screen.getByRole("button", { name: "Set status" });
const labels = () => screen.getAllByRole("menuitem").map((el) => el.textContent ?? "");

async function openSetStatus() {
  await vi.waitFor(() => expect(setStatus()).not.toBeDisabled());
  fireEvent.click(setStatus());
}

beforeEach(() => {
  get.mockResolvedValue({ version: 7, runnerCapabilities: {}, statusExits: EXITS });
});
afterEach(() => {
  cleanup();
  get.mockReset();
  mutate.mockReset();
  pending = false;
});

describe("the bulk bar's On hold", () => {
  it("is offered, beside the statuses that need no reason, and Needs info stays out", async () => {
    bar([row({ id: "a" }), row({ id: "b", status: "in_progress" })]);
    await openSetStatus();
    expect(labels()).toEqual(["On hold", "Dropped"]);
  });

  it("opens the reason dialog once for the selection, naming how many issues it covers", async () => {
    bar([row({ id: "a" }), row({ id: "b" }), row({ id: "c" })]);
    await openSetStatus();
    fireEvent.click(screen.getByRole("menuitem", { name: "On hold" }));
    expect(mutate).not.toHaveBeenCalled();
    expect(await screen.findByText("Put 3 issues on hold")).toBeInTheDocument();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });

  it("says one issue for a selection of one", async () => {
    bar([row({ id: "a" })]);
    await openSetStatus();
    fireEvent.click(screen.getByRole("menuitem", { name: "On hold" }));
    expect(await screen.findByText("Put this issue on hold")).toBeInTheDocument();
  });

  it("sends nothing until a reason is typed, and a reason of only spaces counts as none", async () => {
    bar([row({ id: "a" }), row({ id: "b" })]);
    await openSetStatus();
    fireEvent.click(screen.getByRole("menuitem", { name: "On hold" }));
    const send = await screen.findByRole("button", { name: "Put 2 on hold" });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "   " } });
    expect(send).toBeDisabled();
    fireEvent.click(send);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("sends the one trimmed reason with every selected issue in one update", async () => {
    bar([row({ id: "a" }), row({ id: "b" })]);
    await openSetStatus();
    fireEvent.click(screen.getByRole("menuitem", { name: "On hold" }));
    fireEvent.change(await screen.findByRole("textbox"), {
      target: { value: "  the window is closed  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Put 2 on hold" }));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]?.[0]).toEqual({
      ids: ["a", "b"],
      update: { kind: "status", toStatus: "on_hold", reason: "the window is closed" },
    });
  });

  it("clears the selection and closes the dialog once the update has landed", async () => {
    const { onCleared } = bar([row({ id: "a" }), row({ id: "b" })]);
    await openSetStatus();
    fireEvent.click(screen.getByRole("menuitem", { name: "On hold" }));
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "the window is closed" } });
    fireEvent.click(screen.getByRole("button", { name: "Put 2 on hold" }));
    mutate.mock.calls[0]?.[1].onSuccess();
    expect(onCleared).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  });

  it("keeps the selection when Cancel is pressed", async () => {
    const { onCleared } = bar([row({ id: "a" }), row({ id: "b" })]);
    await openSetStatus();
    fireEvent.click(screen.getByRole("menuitem", { name: "On hold" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(mutate).not.toHaveBeenCalled();
    expect(onCleared).not.toHaveBeenCalled();
  });

  it("still sends a status that needs no reason straight away", async () => {
    bar([row({ id: "a" }), row({ id: "b" })]);
    await openSetStatus();
    fireEvent.click(screen.getByRole("menuitem", { name: "Dropped" }));
    expect(mutate.mock.calls[0]?.[0]).toEqual({
      ids: ["a", "b"],
      update: { kind: "status", toStatus: "dropped" },
    });
  });
});

// ISS-1300 r5 (judge-125, X2): the release door takes a project admin; the bar offers Batch release
// to nobody else, and says who may where it would have been pressed.
describe("Batch release on the bulk bar", () => {
  const waiting = [row({ status: "awaiting_release" }), row({ id: "i2", status: "awaiting_release" })];

  it("is offered to a reader who may release", () => {
    bar(waiting);
    expect(screen.getByRole("button", { name: "Batch release" })).not.toBeDisabled();
  });

  it("is held from a reader who may not, naming who may", () => {
    bar(waiting, vi.fn(), false);
    const button = screen.getByRole("button", { name: "Batch release" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute(
      "title",
      "Only an admin of this project can release them, so ask one of them.",
    );
  });
});
