// ISS-1229 r24, the master's ruling on judge-70's finding: with two unnamed people in a room, the
// question before taking one out named both "another member". People who read alike are told apart
// by when each was added — the day, then the minute, then the order — in the list and the question
// in the same words.

import { afterAll, describe, expect, it, vi } from "vitest";
import { agentPanelWithoutProject, composerRefusal, emptyRoomState, memberName, removalClaim, removalQuestion, unopenableReason } from "./membership";
import type { ConversationParticipant } from "./types";

// When each was added reads in the reader's own time zone (ISS-1229 r25); this reader is at UTC+7.
const zone = vi.hoisted(() => {
  const was = process.env.TZ;
  process.env.TZ = "Asia/Ho_Chi_Minh";
  return was;
});
afterAll(() => {
  process.env.TZ = zone;
});

const person = (id: string, userId: string, addedAt: string, displayName = "Another member"): ConversationParticipant => ({
  id,
  kind: "person",
  userId,
  projectId: null,
  label: null,
  displayName,
  reachable: null,
  addedAt,
});

const roomOf = (...participants: ConversationParticipant[]) => ({ participants, scopeProjects: [] });

describe("two people who read the same name", () => {
  it("are told apart by the day each was added", () => {
    const a = person("pa", "u2", "2026-10-03T09:15:00Z");
    const b = person("pb", "u3", "2026-10-04T09:15:00Z");
    const room = roomOf(a, b);
    expect(memberName(a, "me", "start", room)).toBe("Another member (added 3 Oct 2026)");
    expect(memberName(b, "me", "start", room)).toBe("Another member (added 4 Oct 2026)");
    expect(removalQuestion(a, "me", room).title).toBe("Take another member (added 3 Oct 2026) out of this room?");
    expect(removalClaim(b, room, "me")).toBe("Another member (added 4 Oct 2026) will no longer be listed in this room.");
  });

  it("are told apart by the minute where the day is the same", () => {
    const a = person("pa", "u2", "2026-10-03T09:15:00Z");
    const b = person("pb", "u3", "2026-10-03T14:05:00Z");
    const room = roomOf(a, b);
    expect(memberName(a, "me", "start", room)).toBe("Another member (added 3 Oct 2026, 16:15)");
    expect(removalQuestion(b, "me", room).title).toBe("Take another member (added 3 Oct 2026, 21:05) out of this room?");
  });

  it("are told apart by the day the reader was living, not the server's", () => {
    const a = person("pa", "u2", "2026-10-20T23:50:00Z");
    const b = person("pb", "u3", "2026-10-20T09:15:00Z");
    const room = roomOf(a, b);
    expect(memberName(a, "me", "start", room)).toBe("Another member (added 21 Oct 2026)");
    expect(memberName(b, "me", "start", room)).toBe("Another member (added 20 Oct 2026)");
  });

  it("are told apart by the order they were added where the minute is the same too", () => {
    const a = person("pa", "u2", "2026-10-03T09:15:10Z");
    const b = person("pb", "u3", "2026-10-03T09:15:40Z");
    const room = roomOf(b, a);
    expect(memberName(a, "me", "start", room)).toBe("Another member (added 3 Oct 2026, 16:15, the first)");
    expect(memberName(b, "me", "start", room)).toBe("Another member (added 3 Oct 2026, 16:15, the second)");
    expect(removalQuestion(b, "me", room).title).toBe(
      "Take another member (added 3 Oct 2026, 16:15, the second) out of this room?",
    );
    // The button answers that question, so it keeps the short name and fits a phone's width.
    expect(removalQuestion(b, "me", room).confirm).toBe("Take another member out");
  });

  it("leaves a name nobody else in the room reads alone, and the reader as You", () => {
    const a = person("pa", "u2", "2026-10-03T09:15:00Z", "Mai Tran");
    const b = person("pb", "u3", "2026-10-04T09:15:00Z");
    const me = person("pm", "me", "2026-10-03T09:15:00Z");
    const room = roomOf(a, b, me);
    expect(memberName(a, "me", "start", room)).toBe("Mai Tran");
    expect(memberName(b, "me", "start", room)).toBe("Another member");
    expect(memberName(me, "me", "start", room)).toBe("You");
  });
});

// r34, judge-93: an empty room invites a conversation only where somebody could have one.
describe("emptyRoomState", () => {
  const desk = { id: "p1", name: "Desk", slug: "desk" };
  const agent = (reachable: boolean | null) => ({
    id: "h1",
    kind: "handle" as const,
    userId: "u1",
    projectId: "p1",
    label: null,
    displayName: "desk",
    reachable,
  });

  it("keeps the invitation for a poster in a room whose agent can answer, or whose reach is unknown", () => {
    expect(emptyRoomState({ participants: [agent(true)], scopeProjects: [desk] }, { canPost: true })).toBeNull();
    expect(emptyRoomState({ participants: [agent(null)], scopeProjects: [desk] }, { canPost: true })).toBeNull();
    expect(emptyRoomState(undefined, { canPost: true })).toBeNull();
  });

  // r36, judge-97: at 390 the same can't-answer sentence stood three times; the empty room points to the
  // one place that says why instead of saying it again.
  it("says no agent can answer and points to where why is said: the box for a poster, About for a reader", () => {
    expect(emptyRoomState({ participants: [agent(false)], scopeProjects: [desk] }, { canPost: true })).toEqual({
      title: "No agent here can answer",
      message: "The reason is above the message box.",
    });
    expect(
      emptyRoomState({ participants: [agent(false)], scopeProjects: [desk] }, { canPost: false, projectName: "Desk" }),
    ).toEqual({
      title: "No agent here can answer",
      message:
        "You can read this room, not post in it: you hold the viewer role on Desk. The reason is in this room's About line, at the top.",
    });
  });

  it("tells a viewer of a draft what they can read, and nothing of starting one", () => {
    const said = emptyRoomState(undefined, { canPost: false, projectName: "Desk" });
    expect(said?.message).toBe("You hold the viewer role on Desk, so its conversations are yours to read from the list.");
    expect(`${said?.title} ${said?.message}`).not.toMatch(/start/i);
  });
});

// ISS-1229 r35, judge-95: a viewer of a two-project room was told to take an agent out, which they cannot.
describe("composerRefusal's way out", () => {
  const two = [
    { id: "p1", name: "Desk", slug: "desk" },
    { id: "p2", name: "Ops", slug: "ops" },
  ];
  const agentOn = (projectId: string, reachable: boolean): ConversationParticipant => ({
    id: `h-${projectId}`,
    kind: "handle",
    userId: `u-${projectId}`,
    projectId,
    label: null,
    displayName: projectId,
    reachable,
    addedAt: "2026-10-01T09:00:00Z",
  });
  const answering = [agentOn("p1", true), agentOn("p2", true)];
  it("offers taking an agent out to a reader who may change who is in the room", () => {
    expect(composerRefusal({ scopeProjects: two, participants: answering, canChangeMembership: true })?.wayOut).toBe(
      "Take one of its agents out, and the room can be spoken in again.",
    );
  });
  it("tells a poster who may not who can", () => {
    expect(composerRefusal({ scopeProjects: two, participants: answering, canChangeMembership: false })?.wayOut).toBe(
      "Somebody who can change who is in this room can take one of its agents out, and it can be spoken in again.",
    );
  });
  // r37, judge-100: two agents neither of which can answer were offered as a way out that leaves the room mute.
  it("offers no way out where taking one agent out would still leave no agent that can answer", () => {
    const mute = [agentOn("p1", false), agentOn("p2", false)];
    expect(composerRefusal({ scopeProjects: two, participants: mute, canChangeMembership: true })?.wayOut).toBeNull();
    const oneAnswers = [agentOn("p1", true), agentOn("p2", false)];
    expect(composerRefusal({ scopeProjects: two, participants: oneAnswers, canChangeMembership: true })?.wayOut).toBe(
      "Take one of its agents out, and the room can be spoken in again.",
    );
  });
  it("offers no way out where one agent out still leaves the room about two projects", () => {
    const three = [...two, { id: "p3", name: "Books", slug: "books" }];
    const agents = [agentOn("p1", true), agentOn("p2", true), agentOn("p3", true)];
    expect(composerRefusal({ scopeProjects: three, participants: agents, canChangeMembership: true })?.wayOut).toBeNull();
  });
  it("gives a viewer no way out, only the reason", () => {
    const refusal = composerRefusal({ scopeProjects: two, participants: answering, canChangeMembership: true }, { canPost: false });
    expect(refusal).toEqual({
      reason: "This room is about Desk and Ops, and a message is answered under exactly one project.",
      wayOut: null,
    });
  });
});

// ISS-1229 r36: why Start a conversation cannot pick a project, one sentence per refusal opening would meet.
describe("unopenableReason", () => {
  it("says why for each refusal and nothing for a project that opens", () => {
    expect(unopenableReason({ handle: "ledger", blocked: "lost-role" }, "Ledger")).toBe(
      "@ledger can't answer. This agent no longer holds a role on Ledger, so it cannot answer here.",
    );
    expect(unopenableReason({ handle: "ledger", blocked: "taken" }, "Ledger")).toBe(
      "This project's agent would answer to @ledger, which another agent of this organization already answers to.",
    );
    expect(unopenableReason({ handle: "ledger", blocked: "nameless" }, "Ledger")).toBe(
      "This project's agent has no address in this organization, so no room can start with it.",
    );
    expect(unopenableReason({ handle: "ledger", blocked: null }, "Ledger")).toBeNull();
  });
});

// ISS-1229 r37, judge-100: a reader with no project pressed Conversations and was told to open a project.
describe("the agent panel's door with no project open", () => {
  it("tells a reader with no project that there is none yet, never to open one", () => {
    const said = agentPanelWithoutProject(false, false);
    expect(said).toEqual({
      title: "Conversations",
      description: "There is no project here yet, and a conversation is about a project.",
    });
    expect(said.description).not.toMatch(/open a project/i);
  });
  it("asks a reader with a project to open one, in the door's own name", () => {
    expect(agentPanelWithoutProject(true, true).title).toBe("Ask agent");
    expect(agentPanelWithoutProject(false, true).description).toBe("Open a project to read its conversations.");
  });
});
