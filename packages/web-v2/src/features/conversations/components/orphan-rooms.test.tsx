// @vitest-environment jsdom
//
// ISS-1229 r23, judge-66: after its project was deleted, a room was listed nowhere and nobody could
// delete it. The organization's such rooms are listed under the conversations, each with a delete
// that asks first.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomWithoutAProject } from "../types";

let rooms: RoomWithoutAProject[] = [];
let failed: Error | null = null;
const refetch = vi.fn();
const removeMutate = vi.fn();
let detail: { messages: unknown[]; windows: unknown[] } | undefined;
vi.mock("../hooks", () => ({
  useRoomsWithoutAProject: () => ({ data: failed ? undefined : rooms, isError: failed !== null, error: failed, refetch }),
  useDeleteConversation: () => ({ mutate: removeMutate, isPending: false }),
  useConversation: () => ({ data: detail, isLoading: false, isError: false }),
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

    fireEvent.click(screen.getByRole("button", { name: "Delete Release chat" }));
    expect(removeMutate).not.toHaveBeenCalled();
    expect(screen.getByText(/“Release chat” and everything said in it will be gone/)).toBeTruthy();
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
    expect(onOpen).toHaveBeenCalledWith(rooms[0]);
  });

  it("shows everything said in it, read-only, with no way to write", () => {
    detail = {
      messages: [
        { id: "m1", seq: 0, role: "user", authorUserId: "u1", authorLabel: "Mai", content: "ship it friday", silenceReason: null, createdAt: "2026-10-05T12:00:00Z" },
      ],
      windows: [],
    };
    render(<OrphanRoomView room={room()} onDeleted={vi.fn()} />);
    expect(screen.getByText("ship it friday")).toBeTruthy();
    expect(screen.getByText(/read-only/i)).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Delete Release chat" })).toBeTruthy();
  });
});
