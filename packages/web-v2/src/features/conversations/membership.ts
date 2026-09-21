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

import type {
  ConversationMembership,
  ConversationParticipant,
  ConversationProject,
  HandleCandidate,
} from "./types";

/**
 * One claim a confirmation makes, keyed so a test names the claim and not its wording.
 */
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

/** The same joining, for names rather than projects. */
const list2 = (names: readonly string[]): string => {
  if (names.length === 0) return "Nobody";
  if (names.length === 1) return names[0] as string;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
};

/** Two letters for an avatar, from whatever name there is. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/[\s@._-]+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((w) => w[0] ?? "");
  return (letters.join("") || "?").toUpperCase();
}

/** Where a room's projects come from, said as the derivation it is. */
export function scopeDerivation(
  room: Partial<Pick<ConversationMembership, "scopeProjects">>,
): string {
  return `Read from the agents in this room — ${list(room.scopeProjects)}. Nobody chooses it.`;
}

/** The live agents in a room. */
export function agentsOf(room: Partial<Pick<ConversationMembership, "participants">>) {
  return (room.participants ?? []).filter((p) => p.kind === "handle");
}

/** The live people in a room. */
export function peopleOf(room: Partial<Pick<ConversationMembership, "participants">>) {
  return (room.participants ?? []).filter((p) => p.kind === "person");
}

/**
 * What adding this agent does, claim by claim.
 */
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
      text: `This room will be about ${list(projects)}. That is read from the agents in it, and nobody chooses it.`,
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
  name: string;
  room: Partial<Pick<ConversationMembership, "shape" | "scopeProjects">>;
}): MembershipClaim[] {
  const { name, room } = args;
  if (room.shape === "direct") {
    return [
      {
        key: "person-can-read",
        text: `${name} will be able to read this room, including everything said in it before now.`,
      },
    ];
  }
  return [
    {
      key: "person-already-could",
      text: `Anybody holding a role on ${list(room.scopeProjects)} can already open this room. Adding ${name} lists them here; it changes nobody's access.`,
    },
  ];
}

/** What taking this member out does. */
export function removalClaim(
  participant: ConversationParticipant,
  room: Partial<Pick<ConversationMembership, "scopeProjects" | "participants">>,
): string {
  if (participant.kind !== "handle") {
    return `${participant.displayName ?? "This person"} will no longer be listed in this room.`;
  }
  const rest = agentsOf(room)
    .filter((p) => p.id !== participant.id)
    .map((p) => p.projectId);
  const after = (room.scopeProjects ?? []).filter((p) => rest.includes(p.id));
  return `This room will then be about ${list(after)}. What @${participant.label ?? "this agent"} has already read and already said stays as it is.`;
}

/**
 * Why a room takes no messages from Forge, where it takes none.
 */
export function composerRefusal(
  room: Partial<Pick<ConversationMembership, "scopeProjects">>,
): { reason: string; wayOut: string } | null {
  if (!room.scopeProjects || room.scopeProjects.length <= 1) return null;
  return {
    reason: `This room is about ${list(room.scopeProjects)}, and a message is answered under exactly one project.`,
    wayOut: "Take one of its agents out, and the room can be spoken in again.",
  };
}
