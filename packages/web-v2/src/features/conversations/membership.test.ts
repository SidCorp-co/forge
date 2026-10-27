// What a room says of its people and agents before anyone changes who is in it, and in its empty and
// refused states (ISS-1011, ISS-1229).

import { describe, expect, it } from "vitest";
import { agentPanelWithoutProject, composerRefusal, issueDoorWithoutProject, emptyRoomState, memberName, orderedPeopleOf, removalClaim, removalQuestion, unopenableReason, viewerCannotPost } from "./membership";
import type { ConversationParticipant } from "./types";

const person = (id: string, userId: string, addedAt: string, displayName = "A member"): ConversationParticipant => ({
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

// r49, the coordinator's ruling on judge-146: a room names a person as their messages are signed, the name
// they gave or "A member", never when they were added or their place in that order; the list still
// keeps that order.
describe("people in a room who gave no name", () => {
  it("read A member in the list, the question and the claim, with no added date or ordinal", () => {
    const a = person("pa", "u2", "2026-10-03T09:15:10Z");
    const b = person("pb", "u3", "2026-10-03T09:15:40Z");
    const room = roomOf(b, a);
    expect(memberName(a, "me", "start")).toBe("A member");
    expect(memberName(b, "me", "start")).toBe("A member");
    expect(removalQuestion(b, "me")).toEqual({ title: "Take a member out of this room?", confirm: "Take a member out" });
    // Two people with nothing to tell them apart are said to read alike (r50, criterion 493).
    expect(removalClaim(b, room, "me")).toMatch(/can't be told apart.* A member will no longer be listed in this room\.$/);
  });

  it("are still listed in the order they were added, the opener first among people added at one moment", () => {
    const moment = "2026-10-03T09:15:10Z";
    const opener = person("p-zz", "u-opener", moment);
    const b = person("p-mm", "u-b", moment);
    const c = person("p-aa", "u-c", moment);
    expect(orderedPeopleOf(roomOf(opener, b, c), "u-c").map((p) => p.userId)).toEqual(["u-c", "u-opener", "u-b"]);
  });

  it("leaves a name as given, and the reader as You", () => {
    const a = person("pa", "u2", "2026-10-03T09:15:00Z", "Mai Tran");
    const b = person("pb", "u3", "2026-10-04T09:15:00Z");
    const me = person("pm", "me", "2026-10-03T09:15:00Z");
    expect(memberName(a, "me", "start")).toBe("Mai Tran");
    expect(memberName(b, "me", "start")).toBe("A member");
    expect(memberName(me, "me", "start")).toBe("You");
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
      message: "The reason is in this room's About line, at the top.",
    });
  });

  // ISS-1229 r47 (aea8bed8): a viewer is told once, where the message box would be, why they cannot post and who can.
  it("says a viewer cannot post and who can, in core's words, and the empty room does not say it again", () => {
    expect(viewerCannotPost("Desk")).toBe(
      "You are a viewer of Desk, so you cannot post here. Only a member or admin of Desk can, so ask one of them.",
    );
    const said = emptyRoomState({ participants: [agent(true)], scopeProjects: [desk] }, { canPost: false, projectName: "Desk" });
    expect(said).toEqual({ title: "Nothing has been said here yet", message: "What is said here shows up for you to read." });
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
      "Take @p2 out, and the room can be spoken in again.",
    );
  });
  // r38, judge-103: in a room whose one agent lost its role, "take one of its agents out" let a person take
  // the agent that answers out, which leaves a room nobody answers; the one choice that works is named.
  it("names the agent to take out where only one choice works", () => {
    const oneAnswers = [agentOn("p1", false), agentOn("p2", true)];
    expect(composerRefusal({ scopeProjects: two, participants: oneAnswers, canChangeMembership: true })?.wayOut).toBe(
      "Take @p1 out, and the room can be spoken in again.",
    );
    expect(composerRefusal({ scopeProjects: two, participants: oneAnswers, canChangeMembership: false })?.wayOut).toBe(
      "Somebody who can change who is in this room can take @p1 out, and it can be spoken in again.",
    );
    expect(composerRefusal({ scopeProjects: two, participants: answering, canChangeMembership: true })?.wayOut).not.toMatch(/@/);
  });
  it("points an empty room's reader to the bottom of the room where the bar has taken the box's place", () => {
    const room = { scopeProjects: two, participants: [agentOn("p1", false), agentOn("p2", true)], canChangeMembership: true };
    expect(emptyRoomState(room, { canPost: true })).toEqual({
      title: "Nothing can be sent here",
      message: "The reason is at the bottom of this room, where the message box would be.",
    });
    expect(JSON.stringify(emptyRoomState(room, { canPost: true }))).not.toMatch(/above the message box/);
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
  it("tells a reader who can see no project that there is none they can see, never to open one", () => {
    const said = agentPanelWithoutProject(false, false);
    expect(said).toEqual({
      title: "Conversations",
      description: "This organization holds no project you can see, and a conversation is about a project.",
    });
    expect(said.description).not.toMatch(/open a project/i);
  });
  it("asks a reader with a project to open one, in the door's own name", () => {
    expect(agentPanelWithoutProject(true, true).title).toBe("Ask agent");
    expect(agentPanelWithoutProject(false, true).description).toBe("Open a project to read its conversations.");
  });
});

// ISS-1229 r38: the top bar's New issue told a reader who can see no project to open one.
describe("the New issue door with no project open", () => {
  it("never tells a reader who can see no project to open one", () => {
    expect(issueDoorWithoutProject(false).description).toBe(
      "This organization holds no project you can see, and an issue belongs to a project.",
    );
    expect(issueDoorWithoutProject(false).description).not.toMatch(/open a project/i);
    expect(issueDoorWithoutProject(true).description).toBe("Open a project to create an issue.");
  });
});

// ISS-1229 r48, the master's ruling on judge-142: no room says "Nobody chooses it".
describe("what a room being opened says it will be about", () => {
  it("names its projects as its agents', in plain words, never that nobody chooses it", async () => {
    const { roomOpeningClaims } = await import("./membership");
    const [scope] = roomOpeningClaims({ projects: [{ id: "p1", name: "Billing", slug: "billing" }], agentCount: 1 });
    expect(scope?.text).toBe("This room will be about Billing, the project of the agent in it.");
    const [two] = roomOpeningClaims({
      projects: [
        { id: "p1", name: "Billing", slug: "billing" },
        { id: "p2", name: "Ops", slug: "ops" },
      ],
      agentCount: 2,
    });
    expect(two?.text).toBe("This room will be about Billing and Ops, the projects of the agents in it.");
    expect(two?.text).not.toMatch(/nobody chooses/i);
  });
});
