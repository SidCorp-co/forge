// @vitest-environment jsdom
//
// ISS-1229 r23, judge-66: after its project was deleted, a room was listed nowhere and nobody could
// delete it. The organization's such rooms are listed under the conversations, each with a delete
// that asks first.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomWithoutAProject } from "../types";

// Every time the list shows is in the reader's own time zone (ISS-1229 r25); this reader is at UTC+7.
const zone = vi.hoisted(() => {
  const was = process.env.TZ;
  process.env.TZ = "Asia/Ho_Chi_Minh";
  return was;
});
afterAll(() => {
  process.env.TZ = zone;
});

let rooms: RoomWithoutAProject[] = [];
let failed: Error | null = null;
const refetch = vi.fn();
const removeMutate = vi.fn();
let detail: { messages: unknown[]; windows: unknown[] } | undefined;
let detailFailed: Error | null = null;
const readDetail = vi.fn();
vi.mock("../hooks", () => ({
  useRoomsWithoutAProject: () => ({ data: failed ? undefined : rooms, isError: failed !== null, error: failed, refetch }),
  useDeleteConversation: () => ({ mutate: removeMutate, isPending: false }),
  useConversation: () => ({
    data: detailFailed ? undefined : detail,
    isLoading: false,
    isError: detailFailed !== null,
    error: detailFailed,
    refetch: readDetail,
  }),
}));

const { RoomsWithoutAProject } = await import("./orphan-rooms");
const { OrphanRoomView } = await import("./orphan-room-view");

const room = (over: Partial<RoomWithoutAProject> = {}): RoomWithoutAProject => ({
  id: "r1",
  title: "Release chat",
  shape: "direct",
  archivedAt: null,
  createdAt: "2026-10-03T12:00:00Z",
  updatedAt: "2026-10-20T10:00:00Z",
  deletedProjectNames: ["Billing"],
  lastMessageAt: "2026-10-05T12:00:00Z",
  ...over,
});

beforeEach(() => {
  rooms = [];
  failed = null;
  detailFailed = null;
  readDetail.mockReset();
  refetch.mockReset();
  removeMutate.mockReset();
});
afterEach(cleanup);

describe("rooms whose project was deleted", () => {
  it("shows nothing where the organization holds none", () => {
    const { container } = render(<RoomsWithoutAProject orgId="o1" onOpen={vi.fn()} />);
    expect(container.textContent).toBe("");
  });

  // Review F1: a failed read showed nothing, as if there were no such room.
  it("says the list could not be read, and reads it again on Retry", () => {
    failed = new Error("network down");
    render(<RoomsWithoutAProject orgId="o1" onOpen={vi.fn()} />);
    expect(screen.getByText("Couldn't load the rooms whose project was deleted")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("lists each one, says why it can take no message, and deletes it only once asked", () => {
    rooms = [room(), room({ id: "r2", title: null })];
    render(<RoomsWithoutAProject orgId="o1" onOpen={vi.fn()} />);

    expect(screen.getAllByTestId("room-without-a-project")).toHaveLength(2);
    expect(screen.getByText(/projects are gone, so nobody can write in them/)).toBeTruthy();
    expect(screen.getByText("Untitled conversation")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Delete Release chat, / }));
    expect(removeMutate).not.toHaveBeenCalled();
    expect(screen.getByText(/“Release chat” \(Billing \(deleted\) · opened 3 Oct · last message 5 Oct\) and everything said in it will be gone/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(removeMutate).toHaveBeenCalledTimes(1);
    expect(removeMutate.mock.calls[0]?.[0]).toBe("r1");
  });
});

// ISS-1229 r24, the master's ruling: four identical "Untitled conversation" rows, none openable, and
// Delete permanent. Each row tells its room apart and opens it read-only before any delete.
describe("a room whose project was deleted, told apart", () => {
  it("names the project that went, when the room was opened and when it was last spoken in", () => {
    rooms = [room({ title: null })];
    render(<RoomsWithoutAProject orgId="o1" onOpen={vi.fn()} />);
    const row = screen.getByTestId("room-without-a-project");
    expect(row.textContent).toContain("Billing");
    expect(row.textContent).toMatch(/opened 3 Oct/);
    expect(row.textContent).toMatch(/last message 5 Oct/);
  });

  it("says a project's name was not kept, and that nothing was said, where so", () => {
    rooms = [room({ deletedProjectNames: [], lastMessageAt: null })];
    render(<RoomsWithoutAProject orgId="o1" onOpen={vi.fn()} />);
    const row = screen.getByTestId("room-without-a-project");
    expect(row.textContent).toMatch(/project's name was not kept/);
    expect(row.textContent).toMatch(/nothing said/);
  });

  it("gives each row's control the facts that tell it apart, not only its title", () => {
    rooms = [
      room({ id: "r1", title: null, deletedProjectNames: ["Billing"] }),
      room({ id: "r2", title: null, deletedProjectNames: ["Invoicing"], lastMessageAt: null }),
    ];
    render(<RoomsWithoutAProject orgId="o1" onOpen={() => {}} />);
    const names = screen
      .getAllByRole("button", { name: /^Open .*, read-only: / })
      .map((button) => button.getAttribute("aria-label"));
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(names[0]).toBe("Open Untitled conversation, read-only: Billing (deleted) · opened 3 Oct · last message 5 Oct");
    expect(names[1]).toBe("Open Untitled conversation, read-only: Invoicing (deleted) · opened 3 Oct · nothing said");
  });

  it("opens the room when its row is chosen", () => {
    const onOpen = vi.fn();
    rooms = [room()];
    render(<RoomsWithoutAProject orgId="o1" onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /^Open Release chat/ }));
    expect(onOpen).toHaveBeenCalledWith(rooms[0], ["Billing (deleted)", "opened 3 Oct · last message 5 Oct"]);
  });

  it("shows everything said in it, read-only, with no way to write", () => {
    detail = {
      messages: [
        { id: "m1", seq: 0, role: "user", authorUserId: "u1", authorLabel: "Mai", content: "ship it friday", silenceReason: null, createdAt: "2026-10-05T12:00:00Z" },
      ],
      windows: [],
    };
    render(<OrphanRoomView room={room()} facts={["Billing (deleted)", "opened 3 Oct · last message 5 Oct"]} onDeleted={vi.fn()} />);
    expect(screen.getByText("ship it friday")).toBeTruthy();
    expect(screen.getByText(/read-only/i)).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Delete Release chat, Billing (deleted) · opened 3 Oct · last message 5 Oct" }),
    ).toBeTruthy();
  });
});

// ISS-1229 r48: the room's own read failing said so with no way to read it again.
describe("a room whose project was deleted, whose own read failed", () => {
  it("says it could not be loaded, and Retry reads it again", () => {
    detailFailed = new Error("The server is down.");
    render(<OrphanRoomView room={room()} facts={["Billing (deleted)", "opened 3 Oct"]} onDeleted={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Couldn't load this conversation" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(readDetail).toHaveBeenCalledTimes(1);
  });
});

// ISS-1229 r25, judge-72: two untitled rooms orphaned before names were kept, opened two minutes
// apart, read word for word alike, their Delete controls and questions included. Each now reads apart,
// to the minute where the day is the same and by its place in the order where the minute is too.
describe("two rooms that would read alike", () => {
  const untitled = (id: string, createdAt: string, lastMessageAt: string | null) =>
    room({ id, title: null, deletedProjectNames: [], createdAt, lastMessageAt });

  it("are told apart to the minute, in the reader's time zone, on the row, its Delete and its question", () => {
    rooms = [
      untitled("r1", "2026-10-20T06:33:00Z", "2026-10-20T06:40:00Z"),
      untitled("r2", "2026-10-20T06:35:00Z", "2026-10-20T06:40:00Z"),
    ];
    render(<RoomsWithoutAProject orgId="o1" onOpen={vi.fn()} />);
    const deletes = screen.getAllByRole("button", { name: /^Delete Untitled conversation/ });
    expect(deletes.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Delete Untitled conversation, its project's name was not kept · opened 20 Oct, 13:33 · last message 20 Oct, 13:40",
      "Delete Untitled conversation, its project's name was not kept · opened 20 Oct, 13:35 · last message 20 Oct, 13:40",
    ]);
    const rows = screen.getAllByTestId("room-without-a-project").map((r) => r.textContent);
    expect(new Set(rows).size).toBe(2);
    fireEvent.click(deletes[1] as HTMLElement);
    expect(screen.getByText(/\(its project's name was not kept · opened 20 Oct, 13:35 · last message 20 Oct, 13:40\)/)).toBeTruthy();
  });

  it("are told apart by the order they were opened where the minute is the same too", () => {
    rooms = [
      untitled("r2", "2026-10-20T06:33:40Z", null),
      untitled("r1", "2026-10-20T06:33:10Z", null),
    ];
    render(<RoomsWithoutAProject orgId="o1" onOpen={vi.fn()} />);
    const names = screen
      .getAllByRole("button", { name: /^Open Untitled conversation/ })
      .map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual([
      "Open Untitled conversation, read-only: its project's name was not kept · opened 20 Oct, 13:33 · nothing said · the second opened that minute",
      "Open Untitled conversation, read-only: its project's name was not kept · opened 20 Oct, 13:33 · nothing said · the first opened that minute",
    ]);
  });

  it("keep the day alone where it already tells them apart", () => {
    rooms = [untitled("r1", "2026-10-19T06:33:00Z", null), untitled("r2", "2026-10-20T06:33:00Z", null)];
    render(<RoomsWithoutAProject orgId="o1" onOpen={vi.fn()} />);
    const rows = screen.getAllByTestId("room-without-a-project").map((r) => r.textContent ?? "");
    expect(rows[0]).toContain("opened 19 Oct · nothing said");
    expect(rows[1]).toContain("opened 20 Oct · nothing said");
  });
});
