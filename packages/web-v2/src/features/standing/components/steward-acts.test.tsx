// The steward's acts on an item's Activity (REQ-48 BC-12): each act says what it did, a project writer
// undoes one through its undo door, an act no door undoes says how to override it, and an undone act
// says so. A reader sees the acts and no Undo. The acts are core's item read, newest first.

import type { StewardActRecord } from "@forge/contracts/steward";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { StewardActs } from "./steward-acts";

const act = (id: string, over: Partial<StewardActRecord>): StewardActRecord => ({
  id,
  runId: "r1",
  door: "POST /api/issues/i7/comments",
  did: "Commented on ISS-7.",
  says: { did: { text: "Commented on ISS-7." } } as unknown as StewardActRecord["says"],
  wrote: null,
  undo: null,
  override: null,
  undoneAt: null,
  undoneBy: null,
  at: "2026-10-21T10:00:00Z",
  ...over,
});

const acts = [
  act("a1", { did: "Commented on ISS-7 with the stuck cause.", undo: { door: "DELETE /api/comments/c1", body: null }, at: "2026-10-21T12:00:00Z" }),
  act("a2", { did: "Moved ISS-7 to on_hold.", door: "POST /api/issues/i7/transition", override: "Move the issue yourself: put it on hold, drop it, or send it on.", at: "2026-10-21T11:00:00Z" }),
  act("a3", { did: "Asked whether to keep ISS-7.", undo: { door: "POST /api/questions/q1/void", body: null }, undoneAt: "2026-10-21T13:00:00Z", undoneBy: "u1" }),
];

function core() {
  return fakeCore((call) => {
    // newest first, as core answers it
    if (call.path.startsWith("/projects/p1/steward-acts?")) return { body: { acts } };
    if (call.method === "POST") return { body: { act: { ...acts[0], undoneAt: "2026-10-21T14:00:00Z" }, undone: { status: 204 } } };
    return undefined;
  });
}

describe("the steward's acts on an item (REQ-48 BC-12)", () => {
  it("lists each act newest first, with Undo, an override, or Undone, and undoes through the act's door", async () => {
    const calls = core();
    renderWithQuery(<StewardActs projectId="p1" subjectKey="ISS-7" canWrite />);
    const rows = await screen.findAllByTestId("steward-act");
    expect(rows.map((r) => r.getAttribute("data-act-id"))).toEqual(["a1", "a2", "a3"]);
    expect(calls.some((c) => c.path === "/projects/p1/steward-acts?subject=ISS-7")).toBe(true);
    const [undoable, overridden, undone] = rows as [HTMLElement, HTMLElement, HTMLElement];
    expect(within(undone).getByTestId("steward-act-undone")).toHaveTextContent("Undone");
    expect(within(undone).queryByRole("button", { name: "Undo" })).toBeNull();
    expect(within(overridden).getByTestId("steward-act-override")).toHaveTextContent("Override: Move the issue yourself: put it on hold, drop it, or send it on.");
    expect(within(overridden).queryByRole("button", { name: "Undo" })).toBeNull();
    expect(within(undoable).getByText("Commented on ISS-7 with the stuck cause.")).toBeTruthy();
    await userEvent.setup().click(within(undoable).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(calls).toContainEqual({ method: "POST", path: "/projects/p1/steward-acts/a1/undo", body: undefined }));
  });

  it("offers no Undo to a reader of the project, and still shows what the steward did", async () => {
    core();
    renderWithQuery(<StewardActs projectId="p1" subjectKey="ISS-7" canWrite={false} />);
    expect(await screen.findByText("Commented on ISS-7 with the stuck cause.")).toBeTruthy();
    await waitFor(() => expect(screen.getAllByTestId("steward-act")).toHaveLength(3));
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("draws nothing on an item the steward never acted on", async () => {
    const calls = fakeCore(() => ({ body: { acts: [] } }));
    renderWithQuery(<StewardActs projectId="p1" subjectKey="REQ-3" canWrite />);
    await waitFor(() => expect(calls.some((c) => c.path === "/projects/p1/steward-acts?subject=REQ-3")).toBe(true));
    expect(screen.queryByTestId("steward-acts")).toBeNull();
  });
});
