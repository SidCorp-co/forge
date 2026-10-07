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

import { type Copy, productCopy } from "@/lib/i18n/product-copy";
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

const join = (names: readonly string[], t: Copy): string =>
  names.length === 1
    ? (names[0] as string)
    : t("conversations.listAnd", { head: names.slice(0, -1).join(", "), last: names[names.length - 1] as string });

const list = (projects: readonly ConversationProject[] | undefined, t: Copy): string => {
  const names = (projects ?? []).map((p) => p.name);
  return names.length === 0 ? t("conversations.noProject") : join(names, t);
};

/** The same joining, for names rather than projects. */
const list2 = (names: readonly string[], t: Copy): string => (names.length === 0 ? t("conversations.nobody") : join(names, t));

/** Two letters for an avatar, from whatever name there is. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/[\s@._-]+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((w) => w[0] ?? "");
  return (letters.join("") || "?").toUpperCase();
}

/** Where a room's projects come from, said as the derivation it is. */
export function scopeDerivation(
  room: Partial<Pick<ConversationMembership, "scopeProjects">>,
  t: Copy = productCopy(),
): string {
  return t("conversations.scopeDerivation", { projects: list(room.scopeProjects, t) });
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
  t?: Copy;
}): MembershipClaim[] {
  const { candidate, room } = args;
  const t = args.t ?? productCopy();
  const at = `@${candidate.handle}`;
  const scoped = room.scopeProjects ?? [];
  const isNewProject = !scoped.some((p) => p.id === candidate.project.id);
  const after = isNewProject ? [...scoped, candidate.project] : scoped;
  const becomesShared = room.shape === "direct" && agentsOf(room).length >= 1;

  const claims: MembershipClaim[] = [
    {
      key: "reads-what-was-said",
      text: t("conversations.claim.reads", { at }),
    },
    {
      key: "removal-unreads-nothing",
      text: t("conversations.claim.removal", { at }),
    },
    {
      key: "replies-stay",
      text: t("conversations.claim.replies", { at }),
    },
    {
      key: "scope-after",
      text: t("conversations.claim.scopeAfter", { at, project: candidate.project.name, projects: list(after, t) }),
    },
  ];

  if (isNewProject && after.length > 1) {
    claims.push({
      key: "second-project",
      text: t("conversations.claim.secondProject", { project: candidate.project.name }),
    });
  }

  const losing = candidate.losesReaders ?? [];
  if (losing.length > 0) {
    const one = losing.length === 1;
    claims.push({
      key: "readers-lose",
      text: t(one ? "conversations.claim.loseOne" : "conversations.claim.loseMany", { names: list2(losing, t), project: candidate.project.name }),
    });
  }

  if (becomesShared) {
    claims.push({
      key: "readers-widen",
      text: t("conversations.claim.widen", { projects: list(after, t) }),
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
  t?: Copy;
}): MembershipClaim[] {
  const { projects, agentCount } = args;
  const t = args.t ?? productCopy();
  const claims: MembershipClaim[] = [
    {
      key: "room-scope",
      text: t("conversations.opening.scope", { projects: list(projects, t) }),
    },
  ];
  if (projects.length > 1) {
    claims.push({
      key: "second-project",
      text: t("conversations.opening.second"),
    });
  }
  claims.push(
    agentCount > 1
      ? {
          key: "room-shared",
          text: t("conversations.opening.shared", { projects: list(projects, t) }),
        }
      : {
          key: "room-private",
          text: t("conversations.opening.private"),
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
  t?: Copy;
}): MembershipClaim[] {
  const { name, room } = args;
  const t = args.t ?? productCopy();
  if (room.shape === "direct") {
    return [
      {
        key: "person-can-read",
        text: t("conversations.person.canRead", { name }),
      },
    ];
  }
  return [
    {
      key: "person-already-could",
      text: t("conversations.person.alreadyCould", { projects: list(room.scopeProjects, t), name }),
    },
  ];
}

/** What taking this member out does. */
export function removalClaim(
  participant: ConversationParticipant,
  room: Partial<Pick<ConversationMembership, "scopeProjects" | "participants">>,
  t: Copy = productCopy(),
): string {
  if (participant.kind !== "handle") {
    return t("conversations.removal.person", { name: participant.displayName ?? t("conversations.thisPerson") });
  }
  const rest = agentsOf(room)
    .filter((p) => p.id !== participant.id)
    .map((p) => p.projectId);
  const after = (room.scopeProjects ?? []).filter((p) => rest.includes(p.id));
  return t("conversations.removal.agent", { projects: list(after, t), label: participant.label ?? t("conversations.thisAgent") });
}

/**
 * Why a room takes no messages from Forge, where it takes none.
 */
export function composerRefusal(
  room: Partial<Pick<ConversationMembership, "scopeProjects">>,
  t: Copy = productCopy(),
): { reason: string; wayOut: string } | null {
  if (!room.scopeProjects || room.scopeProjects.length <= 1) return null;
  return {
    reason: t("conversations.composer.reason", { projects: list(room.scopeProjects, t) }),
    wayOut: t("conversations.composer.wayOut"),
  };
}
