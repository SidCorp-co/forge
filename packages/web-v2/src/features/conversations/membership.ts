// The sentences a person reads before they change who is in a room.
//
// They live here, as functions over the room and the candidate, rather than as
// strings inside the dialogues, because each one is a claim about what the code
// does and each one is judged on its own (ISS-1011). A component can be tested
// for rendering a string; only a function can be tested for producing the right
// claim about a given room.
//
// The pre-join claim is the load-bearing one. A turn reads its room back with
// no predicate on any participant row — `added_at` is read nowhere but as an
// ordering tiebreak — and hands the newest of that to the model, bounded by the
// provider history window and not by when an agent joined. So the sentence says
// the agent is shown what has already been said, and it says the bound.

import { personName, readerName } from "@forge/contracts/person-name";
import { addedApart, type ListedPerson, orderPeople } from "@/lib/people/order-people";
import { ApiError } from "@/lib/api/client";
import type {
  BeyondReach,
  ConversationMembership,
  ConversationParticipant,
  ConversationProject,
  HandleCandidate,
  RoomOpener,
} from "./types";

/** One claim a confirmation makes, keyed so a test names the claim and not its wording. */
export interface MembershipClaim {
  key: ClaimKey;
  text: string;
}

export type ClaimKey =
  | "reads-what-was-said"
  | "removal-unreads-nothing"
  | "replies-stay"
  | "scope-after"
  | "second-project"
  | "readers-widen"
  | "readers-lose"
  | "person-can-read"
  | "person-already-could"
  | "room-scope"
  | "room-private"
  | "room-shared";

const list = (projects: readonly ConversationProject[] | undefined): string => {
  const names = (projects ?? []).map((p) => p.name);
  if (names.length === 0) return "no project";
  if (names.length === 1) return names[0] as string;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
};

/** The same joining, for people opening a sentence: only the first name stands at its start (ISS-1229 r22). */
const list2 = (names: readonly string[]): string => {
  if (names.length === 0) return "Nobody";
  const placed = names.map((name, i) => personName(name, i === 0 ? "start" : "inside"));
  if (placed.length === 1) return placed[0] as string;
  return `${placed.slice(0, -1).join(", ")} and ${placed[placed.length - 1]}`;
};

/** Two letters for an avatar, from whatever name there is. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/[\s@._-]+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((w) => w[0] ?? "");
  return (letters.join("") || "?").toUpperCase();
}

/** Which agents answer in this room, in plain words: each that can, by its handle (ISS-1229 r48). */
export function answeringAgents(room: Partial<Pick<ConversationMembership, "participants">>): string {
  const names = agentsOf(room)
    .filter((p) => p.reachable !== false)
    .map((p) => memberName(p));
  if (names.length === 0) return "No agent in this room can answer.";
  if (names.length === 1) return `${names[0]} answers in this room.`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} answer in this room.`;
}

/**
 * Who adds each agent the reader cannot: a member of its project, named in the same sentence (r34). A
 * project the reader can see is named; one they hold no role on is only counted (ISS-1229 r33, judge-92).
 */
export function beyondReachLines(beyond: BeyondReach | undefined): string[] {
  const lines = (beyond?.named ?? []).map(
    (p) => `Ask a member of ${p.name} to add ${p.name}'s agent; you hold the viewer role there.`,
  );
  const unnamed = beyond?.unnamed ?? 0;
  if (unnamed === 1) {
    lines.push(
      "Another project in this organization has its own agent; you hold no role on it, so a member of that project adds it.",
    );
  } else if (unnamed > 1) {
    lines.push(
      `${unnamed} other projects in this organization have their own agents; you hold no role on them, so a member of each of those projects adds its agent.`,
    );
  }
  return lines;
}

/** Why an agent in the room cannot answer: core's `reachable`, read off its role on its own project. */
export function cannotAnswerReason(projectName: string | undefined): string {
  return `This agent no longer holds a role on ${projectName ?? "the project it was added for"}, so it cannot answer here.`;
}

/** About's line per role-less agent (r33), its reason left out where `whyShownAtBox` (r36). */
export function unansweringAgentLines(
  room: Partial<Pick<ConversationMembership, "participants" | "scopeProjects">>,
  whyShownAtBox = false,
): string[] {
  return agentsOf(room)
    .filter((p) => p.reachable === false)
    .map((p) => {
      const project = (room.scopeProjects ?? []).find((s) => s.id === p.projectId)?.name ?? "its project";
      const stays = `This room stays about ${project} while ${memberName(p)} is in it.`;
      return whyShownAtBox ? stays : `${memberName(p)} can't answer: it no longer holds a role on ${project}. ${stays}`;
    });
}

export const WHY_ABOVE_THE_BOX = "The reason is above the message box.";
export const WHY_IN_ABOUT = "The reason is in this room's About line, at the top.";
/** Where the bar saying why nothing can be sent has taken the message box's place (r38, judge-103). */
export const WHY_AT_THE_BOTTOM = "The reason is at the bottom of this room, where the message box would be.";

/** The single home of the reasons: the box for a reader who may post there, else About (r36, judge-97). */
export function whereWhyIsSaid(
  room: Partial<Pick<ConversationMembership, "participants" | "scopeProjects" | "canChangeMembership">>,
  canPost: boolean,
): "box" | "about" | null {
  if (!noAgentAnswers(room)) return null;
  return canPost && !composerRefusal(room, { canPost }) ? "box" : "about";
}

/** Why each agent cannot answer, where none in the room can; null while one still can (r35). */
export function noAgentAnswers(
  room: Partial<Pick<ConversationMembership, "participants" | "scopeProjects">>,
): string[] | null {
  const agents = agentsOf(room);
  if (agents.length === 0 || agents.some((p) => p.reachable !== false)) return null;
  return agents.map((p) => {
    const project = (room.scopeProjects ?? []).find((s) => s.id === p.projectId)?.name ?? "its project";
    return `${memberName(p)} can't answer: it no longer holds a role on ${project}, and answers again once it does.`;
  });
}

/** What a room's message box says where no agent can answer: a person may still post (r35, judge-95). */
export const NO_AGENT_WILL_ANSWER = "No agent here will answer what you send.";

/** A room is opened by somebody holding the member role or above on its project (ISS-1229 r35). */
export const startsRooms = (role: string | null | undefined) => role === "member" || role === "admin";

/** Why a project cannot be picked to start a room, where its own agent cannot be reached there (r36). */
export function unopenableReason(opener: Pick<RoomOpener, "handle" | "blocked">, projectName: string): string | null {
  if (opener.blocked === "nameless") return "This project's agent has no address in this organization, so no room can start with it.";
  if (opener.blocked === "taken") {
    return `This project's agent would answer to @${opener.handle}, which another agent of this organization already answers to.`;
  }
  return opener.blocked === "lost-role" ? `@${opener.handle} can't answer. ${cannotAnswerReason(projectName)}` : null;
}

/** What holds an offered agent back, in the words its room row or the project picker uses (r37). */
export function candidateHeldReason(candidate: Pick<HandleCandidate, "handle" | "blocked" | "reachable" | "project">): string | null {
  if (candidate.blocked === "taken") return unopenableReason(candidate, candidate.project.name);
  return candidate.reachable ? null : cannotAnswerReason(candidate.project.name);
}

/** The agent panel's heading before its room loads: never New conversation to a reader who may not start one. */
export function draftHeading(roomId: string | undefined, canStart: boolean): string {
  if (roomId) return "Conversation";
  return canStart ? "New conversation" : "Conversations";
}

/** The agent panel's door with no project open: never "open a project" to a reader who can see none (r37). */
export function agentPanelWithoutProject(mayStart: boolean, anyProject: boolean): { title: string; description: string } {
  if (!anyProject) {
    return { title: "Conversations", description: "This organization holds no project you can see, and a conversation is about a project." };
  }
  return mayStart
    ? { title: "Ask agent", description: "Open a project to ask the agent." }
    : { title: "Conversations", description: "Open a project to read its conversations." };
}

/** The top bar's New issue with no project open, said as agentPanelWithoutProject says its door (r38). */
export function issueDoorWithoutProject(anyProject: boolean): { title: string; description: string } {
  return anyProject
    ? { title: "New issue", description: "Open a project to create an issue." }
    : { title: "New issue", description: "This organization holds no project you can see, and an issue belongs to a project." };
}

/** What the top bar names the agent panel: Ask agent only where the reader may start a room (r36). */
export const agentPanelName = (mayStart: boolean) => (mayStart ? "Ask agent" : "Conversations");

/** Renaming, archiving and deleting a room take that role on every project it is about, as core asks. */
export const changesRoom = (
  room: { scope: readonly string[]; projectId: string },
  roleOf: (projectId: string) => string | null | undefined,
) => (room.scope.length > 0 ? room.scope : [room.projectId]).every((id) => startsRooms(roleOf(id)));

export const READ_ONLY_LIST_EMPTY = "Conversations on your projects show up here to read.";

const VIEWER_READS = "What is said here shows up for you to read.";

export const NO_ACCESS_TITLE = "No access to this conversation";

export function refusedForScope(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 403 && err.code !== "NOT_IN_THE_ROOM";
}

/** Why a viewer cannot post, and who can, in core's words, said where the message box would be (ISS-1229 r47, aea8bed8). */
export function viewerCannotPost(projectName: string): string {
  return `You are a viewer of ${projectName}, so you cannot post here. Only a member or admin of ${projectName} can, so ask one of them.`;
}

/** An empty room's title and line where an invitation would be untrue, else null (ISS-1229 r34). */
export function emptyRoomState(
  room:
    | Partial<Pick<ConversationMembership, "participants" | "scopeProjects" | "canChangeMembership">>
    | undefined,
  reader: { canPost: boolean; projectName?: string | undefined },
): { title: string; message: string } | null {
  const where = reader.projectName ?? "this project";
  if (!room) {
    return reader.canPost
      ? null
      : {
          title: "Conversations you can read",
          message: `You hold the viewer role on ${where}, so its conversations are yours to read from the list.`,
        };
  }
  const whySaid = whereWhyIsSaid(room, reader.canPost);
  if (whySaid) {
    return { title: "No agent here can answer", message: whySaid === "box" ? WHY_ABOVE_THE_BOX : WHY_IN_ABOUT };
  }
  if (!reader.canPost) return { title: "Nothing has been said here yet", message: VIEWER_READS };
  if (composerRefusal(room, reader)) return { title: "Nothing can be sent here", message: WHY_AT_THE_BOTTOM };
  return null;
}

/** The live agents in a room. */
export function agentsOf(room: Partial<Pick<ConversationMembership, "participants">>) {
  return (room.participants ?? []).filter((p) => p.kind === "handle");
}

/** The live people in a room. */
export function peopleOf(room: Partial<Pick<ConversationMembership, "participants">>) {
  return (room.participants ?? []).filter((p) => p.kind === "person");
}

/** What adding this agent does, claim by claim. */
export function agentAdditionClaims(args: {
  candidate: HandleCandidate;
  room: Partial<Pick<ConversationMembership, "shape" | "scopeProjects" | "participants">>;
}): MembershipClaim[] {
  const { candidate, room } = args;
  const at = `@${candidate.handle}`;
  const scoped = room.scopeProjects ?? [];
  const isNewProject = !scoped.some((p) => p.id === candidate.project.id);
  const after = isNewProject ? [...scoped, candidate.project] : scoped;
  const becomesShared = room.shape === "direct" && agentsOf(room).length >= 1;

  const claims: MembershipClaim[] = [
    {
      key: "reads-what-was-said",
      text: `${at} will be shown what has already been said in this room, not only what is said after it joins. It reads the recent part of the room, not the whole of it.`,
    },
    {
      key: "removal-unreads-nothing",
      text: `Taking ${at} out later stops it reading and answering from that moment. It does not unread what it has already read.`,
    },
    {
      key: "replies-stay",
      text: `Anything ${at} says here stays in the room, and everyone here will have seen it.`,
    },
    {
      key: "scope-after",
      text: `${at} brings ${candidate.project.name}. This room will then be about ${list(after)}.`,
    },
  ];

  if (isNewProject && after.length > 1) {
    claims.push({
      key: "second-project",
      text: `${candidate.project.name} is a second project for this room. While a room is about more than one project, no message can be sent to it from Forge — a message is answered under exactly one project. Take an agent out to send here again.`,
    });
  }

  const losing = candidate.losesReaders ?? [];
  if (losing.length > 0) {
    const one = losing.length === 1;
    claims.push({
      key: "readers-lose",
      text: `${list2(losing)} ${one ? "is" : "are"} in this room today and ${one ? "holds" : "hold"} no role on ${candidate.project.name}. A room is read only by somebody who holds one on every project in it, so they will no longer be able to open this one. Nothing they have already read is taken back.`,
    });
  }

  if (becomesShared) {
    claims.push({
      key: "readers-widen",
      text: `This is a one-to-one room, read only by the people in it. With a second agent it becomes a shared room, and anybody holding a role on ${list(after)} will be able to read it.`,
    });
  }

  return claims;
}

/**
 * What the room being opened will be, said before it is opened.
 */
export function roomOpeningClaims(args: {
  projects: readonly ConversationProject[];
  agentCount: number;
}): MembershipClaim[] {
  const { projects, agentCount } = args;
  const claims: MembershipClaim[] = [
    {
      key: "room-scope",
      text: `This room will be about ${list(projects)}, ${projects.length > 1 ? "the projects of the agents" : "the project of the agent"} in it.`,
    },
  ];
  if (projects.length > 1) {
    claims.push({
      key: "second-project",
      text: `A room about more than one project takes no messages from Forge — a message is answered under exactly one project. Take an agent out afterwards, and the room can be spoken in.`,
    });
  }
  claims.push(
    agentCount > 1
      ? {
          key: "room-shared",
          text: `With more than one agent this is a shared room: anybody holding a role on ${list(projects)} will be able to read it, not only the people listed here.`,
        }
      : {
          key: "room-private",
          text: "With one agent this is a one-to-one room, read only by the people in it.",
        },
  );
  return claims;
}

/**
 * What adding this person does, which is a smaller thing and says so.
 */
export function personAdditionClaims(args: {
  displayName: string | null;
  room: Partial<Pick<ConversationMembership, "shape" | "scopeProjects">>;
}): MembershipClaim[] {
  const { displayName, room } = args;
  if (room.shape === "direct") {
    return [
      {
        key: "person-can-read",
        text: `${personName(displayName, "start")} will be able to read this room, including everything said in it before now.`,
      },
    ];
  }
  return [
    {
      key: "person-already-could",
      text: `Anybody holding a role on ${list(room.scopeProjects)} can already open this room. Adding ${personName(displayName)} lists them here; it changes nobody's access.`,
    },
  ];
}

/** A room's members as a list of people reads them, keyed by row, in the place core serves each at:
 *  core serves people added at one moment with the room's opener first (ISS-1229 r45). */
function listedMembers(
  room: Partial<Pick<ConversationMembership, "participants">>,
): (p: ConversationParticipant) => ListedPerson {
  const people = peopleOf(room);
  return (p) => {
    const place = people.findIndex((q) => q.id === p.id);
    return {
      userId: p.userId,
      displayName: p.displayName,
      addedAt: p.addedAt,
      key: p.id,
      ...(place < 0 ? {} : { place }),
    };
  };
}

/**
 * What tells a person apart from others in the room who read the same name (ISS-1229 r24): the day
 * they were added, then the minute, then their place in the order added (`addedApart`).
 */
function addedWords(
  participant: ConversationParticipant,
  room: Partial<Pick<ConversationMembership, "participants">>,
  viewerId?: string | null,
): string | null {
  if (participant.kind !== "person") return null;
  const listed = listedMembers(room);
  return addedApart(listed(participant), peopleOf(room).map((p) => listed(p)), viewerId);
}

/** A room's people in the order every list of people takes: the reader, names, then the unnamed by
 *  when each was added (ISS-1229 r28). */
export function orderedPeopleOf(
  room: Partial<Pick<ConversationMembership, "participants">>,
  viewerId?: string | null,
): ConversationParticipant[] {
  return orderPeople(peopleOf(room), viewerId, listedMembers(room));
}

/** How a member is named in the room's list: the reader's own row reads "You" (ISS-1229 r23), and
 *  people who read alike carry when each was added, in the list and every question about them (r24). */
export function memberName(
  participant: ConversationParticipant,
  viewerId?: string | null,
  at: "inside" | "start" = "start",
  room?: Partial<Pick<ConversationMembership, "participants">>,
): string {
  if (participant.kind === "handle") return `@${participant.displayName ?? participant.label ?? "agent"}`;
  const name = readerName(participant.userId, viewerId, participant.displayName, at);
  const apart = room ? addedWords(participant, room, viewerId) : null;
  return apart ? `${name} (${apart})` : name;
}

/** What taking this member out does. */
export function removalClaim(
  participant: ConversationParticipant,
  room: Partial<Pick<ConversationMembership, "scopeProjects" | "participants">>,
  viewerId?: string | null,
): string {
  if (participant.kind !== "handle") {
    return `${memberName(participant, viewerId, "start", room)} will no longer be listed in this room.`;
  }
  const rest = agentsOf(room)
    .filter((p) => p.id !== participant.id)
    .map((p) => p.projectId);
  const after = (room.scopeProjects ?? []).filter((p) => rest.includes(p.id));
  return `This room will then be about ${list(after)}. What @${participant.label ?? "this agent"} has already read and already said stays as it is.`;
}

/**
 * Why this member cannot be taken out, in the words core refuses it with, or null where they can:
 * the room's last agent, and the last person of a one-to-one room (ISS-1229 r27).
 */
export function removalHeld(
  participant: ConversationParticipant,
  room: Partial<Pick<ConversationMembership, "participants" | "shape">>,
): string | null {
  if (participant.kind === "handle" && agentsOf(room).length <= 1) {
    return "This room has one agent left. Without an agent nobody could get an answer in this room, and people who reach it only through its project could no longer open it. Add another agent first, or delete the room.";
  }
  if (participant.kind === "person" && room.shape === "direct" && peopleOf(room).length <= 1) {
    return "This room is a one-to-one room with one person left, and a room with nobody in it is readable by nobody; add another person first, or delete the room.";
  }
  return null;
}

/** The agents whose taking out leaves a room about one project with an agent that can answer (r37). */
function agentsToTakeOut(room: Partial<Pick<ConversationMembership, "participants">>) {
  const agents = agentsOf(room);
  return agents.filter((out) => {
    const left = agents.filter((p) => p.id !== out.id);
    return new Set(left.map((p) => p.projectId)).size === 1 && left.some((p) => p.reachable !== false);
  });
}

/**
 * Why a room takes no messages from Forge, where it takes none, and the way out for this reader: taking
 * an agent out, said to one who may; who can, to any other who could then post; none to a reader who
 * could not post either way (ISS-1229 r35, judge-95), nor where it would not make the room speakable (r37).
 */
export function composerRefusal(
  room: Partial<Pick<ConversationMembership, "scopeProjects" | "canChangeMembership" | "participants">>,
  reader: { canPost: boolean } = { canPost: true },
): { reason: string; wayOut: string | null } | null {
  if (!room.scopeProjects || room.scopeProjects.length <= 1) return null;
  const reason = `This room is about ${list(room.scopeProjects)}, and a message is answered under exactly one project.`;
  const outs = agentsToTakeOut(room);
  if (!reader.canPost || outs.length === 0) return { reason, wayOut: null };
  const which = outs.length === 1 ? memberName(outs[0] as ConversationParticipant) : "one of its agents";
  return {
    reason,
    wayOut:
      room.canChangeMembership === true
        ? `Take ${which} out, and the room can be spoken in again.`
        : `Somebody who can change who is in this room can take ${which} out, and it can be spoken in again.`,
  };
}

/** The question asked before a member is taken out, naming who (ISS-1229 r23). */
export function removalQuestion(
  participant: ConversationParticipant,
  viewerId?: string | null,
  room?: Partial<Pick<ConversationMembership, "participants">>,
): { title: string; confirm: string } {
  const self = participant.kind === "person" && Boolean(viewerId) && participant.userId === viewerId;
  const who = self ? "yourself" : memberName(participant, viewerId, "inside", room);
  // The button answers the question above it, so it keeps the short name: the full one, with when they
  // were added, made the button push Cancel off a phone's width (ISS-1229 r24).
  const short = self ? "yourself" : memberName(participant, viewerId, "inside");
  return { title: `Take ${who} out of this room?`, confirm: self ? "Take me out" : `Take ${short} out` };
}
