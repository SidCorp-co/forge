// @vitest-environment jsdom
//
// ISS-1229 r25 after-shot: two unnamed people in a room are told apart by when each was added, and the
// people list cut each name at the column's edge, so the words that tell them apart were the words lost.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationMembers } from "./conversation-members";

vi.mock("../hooks", () => ({
  useConversationCandidates: () => ({ isLoading: false, isError: false, data: { people: [], handles: [] } }),
  useAddPerson: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false }),
  useRemoveParticipant: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useAddHandle: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false }),
}));
vi.mock("@/providers/auth-provider", () => ({ useAuth: () => ({ user: { id: "me" } }) }));

afterEach(cleanup);

const person = (id: string, addedAt: string) => ({
  id: `p-${id}`,
  kind: "person" as const,
  userId: id,
  projectId: null,
  label: null,
  displayName: "Another member",
  reachable: null,
  addedAt,
});
const agent = {
  id: "a1",
  kind: "handle" as const,
  userId: "agent",
  projectId: "p1",
  label: "@billing-agent-with-a-long-handle",
  displayName: null,
  reachable: true,
};
const room = { shape: "group" as const, scopeProjects: [{ id: "p1", name: "Billing", slug: "billing" }] };

describe("a room's people list", () => {
  it("wraps a person's name rather than cutting off what tells two of them apart", () => {
    render(
      <ConversationMembers
        conversationId="c1"
        room={{ ...room, participants: [person("u2", "2026-10-20T02:43:00Z"), person("u3", "2026-10-20T02:43:00Z"), agent] }}
        canChange
        open
        onClose={() => {}}
      />,
    );
    const names = screen.getAllByTestId("member-row-person").map((row) => row.querySelector(".fg-body-sm"));
    expect(names).toHaveLength(2);
    for (const name of names) {
      expect(name?.textContent).toMatch(/^Another member \(added .+, the (first|second)\)$/);
      expect(name?.classList.contains("truncate")).toBe(false);
      expect(name?.classList.contains("break-words")).toBe(true);
    }
  });
});
