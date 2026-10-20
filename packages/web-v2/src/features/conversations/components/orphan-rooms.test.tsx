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
vi.mock("../hooks", () => ({
  useRoomsWithoutAProject: () => ({ data: failed ? undefined : rooms, isError: failed !== null, error: failed, refetch }),
  useDeleteConversation: () => ({ mutate: removeMutate, isPending: false }),
}));

const { RoomsWithoutAProject } = await import("./orphan-rooms");

const room = (over: Partial<RoomWithoutAProject> = {}): RoomWithoutAProject => ({
  id: "r1",
  title: "Release chat",
  shape: "direct",
  archivedAt: null,
  updatedAt: "2026-10-20T10:00:00Z",
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
    const { container } = render(<RoomsWithoutAProject orgId="o1" />);
    expect(container.textContent).toBe("");
  });

  // Review F1: a failed read showed nothing, as if there were no such room.
  it("says the list could not be read, and reads it again on Retry", () => {
    failed = new Error("network down");
    render(<RoomsWithoutAProject orgId="o1" />);
    expect(screen.getByText("Couldn't load the rooms whose project was deleted")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("lists each one, says why it can take no message, and deletes it only once asked", () => {
    rooms = [room(), room({ id: "r2", title: null })];
    render(<RoomsWithoutAProject orgId="o1" />);

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
