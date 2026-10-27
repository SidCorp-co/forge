// @vitest-environment jsdom
//
// ISS-1229 r50, judge-152 on criterion 486: the nameless owner who opened a room and a nameless viewer read as two
// identical "A member / Person" rows, with identical remove controls and questions, so the named member could not
// take one out without risking the other. The master's ruling: two people who read alike are told apart by their
// role on the room's project, then by whether they opened the room, never by a date, an order or an address; where
// they still read alike, the row says so.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { personStanding, removalClaim, removalQuestion, removeControlName } from "../membership";
import type { ConversationMembership, ConversationParticipant } from "../types";
import { ConversationMembers } from "./conversation-members";

vi.mock("../hooks", () => ({
  useRemoveParticipant: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useConversationCandidates: () => ({ isLoading: false, isError: false, data: { people: [], handles: [] } }),
  useAddPerson: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false }),
  useAddHandle: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false }),
}));
vi.mock("@/providers/auth-provider", () => ({ useAuth: () => ({ user: { id: "mai" } }) }));
vi.mock("@/features/projects/hooks", () => ({ useOrgScopedProjects: () => ({ projects: [] }) }));

expect.extend(matchers);
afterEach(cleanup);

const DESK = { id: "p1", name: "J152 desk", slug: "j152-desk" };

const person = (
  id: string,
  displayName: string | null,
  role: "admin" | "member" | "viewer" | null,
  opener = false,
): ConversationParticipant => ({
  id,
  kind: "person",
  userId: id,
  projectId: null,
  label: null,
  displayName,
  reachable: null,
  addedAt: "2026-10-27T10:00:00.000Z",
  roles: [{ projectId: DESK.id, role }],
  opener,
});

const agent: ConversationParticipant = {
  id: "a1",
  kind: "handle",
  userId: null,
  projectId: DESK.id,
  label: "j152-desk",
  displayName: "j152-desk",
  reachable: true,
};

const roomOf = (...people: ConversationParticipant[]): Partial<ConversationMembership> => ({
  shape: "group",
  participants: [agent, ...people],
  scope: [DESK.id],
  scopeProjects: [DESK],
  canChangeMembership: true,
});

// judge-152's room: the nameless owner opened it (admin by their organization role), a nameless viewer, and Mai.
const owner = person("owner", null, "admin", true);
const viewer = person("viewer", null, "viewer");
const mai = person("mai", "Mai QA", "member");

describe("two people who read alike in a room (criteria 486, 492, 493, 494)", () => {
  it("are told apart by their role on the room's project in the remove control and its question", () => {
    const room = roomOf(owner, viewer, mai);
    expect(removeControlName(owner, room, "mai")).toBe("Take a member with the admin role out of the room");
    expect(removeControlName(viewer, room, "mai")).toBe("Take a member with the viewer role out of the room");
    expect(removalQuestion(viewer, "mai", room).title).toBe("Take a member with the viewer role out of this room?");
    expect(removalClaim(viewer, room, "mai")).toBe("A member with the viewer role will no longer be listed in this room.");
  });

  it("show each one's role, and who opened the room, on the row, never a date, an order or an address", () => {
    render(<ConversationMembers conversationId="c1" room={roomOf(owner, viewer, mai)} canChange open onClose={() => {}} />);
    const rows = screen.getAllByTestId("member-row-person").map((r) => r.textContent ?? "");
    expect(rows).toEqual([
      expect.stringContaining("YouMember"),
      expect.stringContaining("A memberAdmin · Opened this room"),
      expect.stringContaining("A memberViewer"),
    ]);
    for (const row of rows) {
      expect(row).not.toMatch(/added|first|second|@|2026/i);
    }
    const controls = screen.getAllByRole("button", { name: /^Take a member/ }).map((b) => b.getAttribute("aria-label"));
    expect(new Set(controls).size).toBe(2);
  });

  it("name the opener where both hold the same role", () => {
    const opened = person("o", null, "member", true);
    const other = person("x", null, "member");
    const room = roomOf(opened, other, mai);
    expect(removeControlName(opened, room, "mai")).toBe("Take a member who opened this room out of the room");
    expect(removeControlName(other, room, "mai")).toBe("Take a member who did not open this room out of the room");
    expect(personStanding(opened, room, "mai")).toEqual({
      line: "Member · Opened this room",
      apart: "who opened this room",
      alike: false,
    });
  });

  it("say so on each row and in the removal question where name, role and opening it all match", () => {
    const one = person("o", null, "viewer");
    const two = person("x", null, "viewer");
    const room = roomOf(one, two, mai);
    expect(personStanding(one, room, "mai").alike).toBe(true);
    expect(removalClaim(one, room, "mai")).toMatch(/^This person can't be told apart from another person in this room/);
    render(<ConversationMembers conversationId="c1" room={room} canChange open onClose={() => {}} />);
    const alike = screen
      .getAllByTestId("member-row-person")
      .filter((r) => r.textContent?.includes("Can't be told apart from another person here"));
    expect(alike).toHaveLength(2);
    fireEvent.click(within(alike[0] as HTMLElement).getByRole("button", { name: /^Take a member/ }));
    expect(screen.getByRole("dialog", { name: /Take a member out of this room\?/ })).toHaveTextContent(
      "This person can't be told apart from another person in this room",
    );
  });

  it("adds nothing to a name nobody else in the room shares", () => {
    const room = roomOf(owner, mai);
    expect(removeControlName(owner, room, "mai")).toBe("Take a member out of the room");
    expect(personStanding(owner, room, "mai").apart).toBeNull();
  });
});
