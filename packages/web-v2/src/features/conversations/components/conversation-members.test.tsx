// @vitest-environment jsdom
//
// ISS-1229 r25 after-shot: two unnamed people in a room are told apart by when each was added, and the
// people list cut each name at the column's edge, so the words that tell them apart were the words lost.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationMembers } from "./conversation-members";
import { ScopeNotice } from "./scope-notice";

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
  label: "billing-agent-with-a-long-handle",
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

// r32, judge-90: an agent answering in the room was marked "can't act" for holding no personal token,
// which answering in a room never uses. The mark now says what is true of the agent in that room.
describe("an agent's row", () => {
  const roster = (reachable: boolean) => (
    <ConversationMembers
      conversationId="c1"
      room={{ ...room, participants: [{ ...agent, reachable }] }}
      canChange
      open
      onClose={() => {}}
    />
  );

  it("carries no mark while the agent can answer here", () => {
    render(roster(true));
    const row = screen.getByTestId("member-row-agent");
    expect(row.textContent).not.toMatch(/can.t (act|answer)/);
  });

  it("says it cannot answer here once the agent has lost its role on the room's project", () => {
    render(roster(false));
    const mark = screen.getByTestId("member-cannot-answer");
    expect(mark.textContent).toBe("can't answer");
    expect(screen.getByTestId("member-row-agent").textContent).not.toMatch(/can't act/);
  });

  // r33, judge-92: the reason was a bubble a tap put over the next agent's take-out control at 390.
  it("gives its reason in its own row, in the flow, with no bubble to cover another control", () => {
    render(roster(false));
    const reason = screen.getByTestId("member-cannot-answer-reason");
    expect(reason.textContent).toBe("This agent no longer holds a role on Billing, so it cannot answer here.");
    expect(reason.closest(".flex-col")?.contains(screen.getByTestId("member-row-agent"))).toBe(true);
    expect(screen.getByTestId("member-cannot-answer").closest("[data-tooltip],[role=tooltip]")).toBeNull();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("gives no reason while the agent can answer here", () => {
    render(roster(true));
    expect(screen.queryByTestId("member-cannot-answer-reason")).toBeNull();
  });
});

// r33, judge-92: About kept naming the project of an agent that cannot answer, with nothing saying so.
describe("the About panel of a room holding an agent that cannot answer", () => {
  const full =
    "@billing-agent-with-a-long-handle can't answer: it no longer holds a role on Billing. This room stays about Billing while @billing-agent-with-a-long-handle is in it.";

  it("says the agent cannot answer and that the room stays about its project, to a reader who cannot post", () => {
    render(<ScopeNotice room={{ ...room, participants: [{ ...agent, reachable: false }] }} canPost={false} />);
    expect(screen.getByTestId("scope-notice-unanswering").textContent).toBe(full);
  });

  // ISS-1229 r36, judge-97: the line above the message box already says why, so About does not repeat it.
  it("says only that the room stays about its project where the message box already says why", () => {
    render(<ScopeNotice room={{ ...room, participants: [{ ...agent, reachable: false }] }} />);
    expect(screen.getByTestId("scope-notice-unanswering").textContent).toBe(
      "This room stays about Billing while @billing-agent-with-a-long-handle is in it.",
    );
  });

  it("says why where another agent still answers, since nothing above the box does", () => {
    const answering = { ...agent, id: "h-2", userId: "u-2", displayName: "billing-2", reachable: true };
    render(<ScopeNotice room={{ ...room, participants: [{ ...agent, reachable: false }, answering] }} />);
    expect(screen.getByTestId("scope-notice-unanswering").textContent).toBe(full);
  });

  it("says nothing of the kind while every agent can answer", () => {
    render(<ScopeNotice room={{ ...room, participants: [agent] }} />);
    expect(screen.queryByTestId("scope-notice-unanswering")).toBeNull();
  });
});
