// What an issue's Activity tab says for each event: a sentence that opens with who acted (ISS-1229
// r22). Every action core writes has its own words, keyed by the contracts vocabulary so a new one
// does not compile until it has them; a row this build cannot know still reads as a change by its
// actor, never as the code it was stored under.

import { type IssueActivityAction, ISSUE_ACTIVITY_ACTIONS } from "@forge/contracts/issue-vocabulary";
import { personName } from "@forge/contracts/person-name";
import type { IconName } from "@/design";
import { statusLabel } from "./derive";
import type { ActivityItem, IssueStatus } from "./types";

/** A run of the sentence; `strong` marks a value a reader scans for, such as a status. */
export type SentencePart = string | { strong: string };

export interface ActivitySentence {
  icon: IconName;
  actor: string;
  /** What the actor did, read straight after their name. */
  did: SentencePart[];
}

type Payload = Record<string, unknown>;

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** A field name as words: `acceptanceCriteria` → "acceptance criteria". */
const fieldWords = (field: string): string =>
  field.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();

const joined = (words: string[]): string =>
  words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;

function edited(p: Payload): SentencePart[] {
  const fields = Array.isArray(p.fields) ? p.fields.filter((f): f is string => typeof f === "string") : [];
  if (fields.length === 0) return ["changed this issue"];
  const [only] = fields;
  if (fields.length === 1 && only) {
    const from = text((p.before as Payload | undefined)?.[only]);
    const to = text((p.after as Payload | undefined)?.[only]);
    if (from && to && from.length <= 40 && to.length <= 40)
      return [`changed the ${fieldWords(only)} from `, { strong: from }, " to ", { strong: to }];
  }
  return [`changed the ${joined(fields.map(fieldWords))}`];
}

function named(p: Payload, what: string): string {
  const name = text(p.name);
  return name ? `${what} "${name}"` : `${what === "attached" ? "attached a file" : `${what} an attachment`}`;
}

const SENTENCES: Record<IssueActivityAction, (p: Payload) => { icon: IconName; did: SentencePart[] }> = {
  "issue.created": () => ({ icon: "plus", did: ["created this issue"] }),
  "issue.updated": (p) => ({ icon: "rename", did: edited(p) }),
  "issue.assigned": (p) => ({ icon: "agent", did: [p.after ? "assigned this issue" : "unassigned this issue"] }),
  "issue.statusChanged": (p) => {
    const from = text(p.from);
    const to = text(p.to);
    if (!to) return { icon: "pipeline", did: ["moved this issue"] };
    return {
      icon: "pipeline",
      did: from
        ? ["moved this issue from ", { strong: statusLabel(from as IssueStatus) }, " to ", { strong: statusLabel(to as IssueStatus) }]
        : ["moved this issue to ", { strong: statusLabel(to as IssueStatus) }],
    };
  },
  "issue.labeled": () => ({ icon: "star", did: ["added a label"] }),
  "issue.unlabeled": () => ({ icon: "star", did: ["removed a label"] }),
  "issue.dependency.added": () => ({ icon: "link", did: ["added a dependency"] }),
  "issue.dependency.updated": () => ({ icon: "link", did: ["changed a dependency"] }),
  "issue.dependency.removed": () => ({ icon: "link", did: ["removed a dependency"] }),
  "issue.attachment.uploaded": (p) => ({ icon: "pin", did: [named(p, "attached")] }),
  "issue.attachment.deleted": (p) => ({ icon: "pin", did: [named(p, "removed")] }),
  "issue.archived": () => ({ icon: "archive", did: ["archived this issue"] }),
  "issue.unarchived": () => ({ icon: "archive", did: ["brought this issue back from the archive"] }),
  "comment.created": () => ({ icon: "chat", did: ["commented"] }),
  "comment.updated": () => ({ icon: "chat", did: ["edited a comment"] }),
  "comment.deleted": () => ({ icon: "chat", did: ["deleted a comment"] }),
  "comment.mentioned": (p) => {
    const n = Array.isArray(p.mentionedUserIds) ? p.mentionedUserIds.length : 0;
    return { icon: "chat", did: [n > 1 ? `mentioned ${n} members in a comment` : "mentioned a member in a comment"] };
  },
  "agent-session.created": () => ({ icon: "agent", did: ["started an agent session"] }),
  "agent-session.pipelineControl.changed": (p) => ({
    icon: p.paused ? "pause" : "play",
    did: [p.paused ? "paused the agent's work on this issue" : "let the agent's work on this issue go on"],
  }),
  module_knowledge_refreshed: () => ({ icon: "book", did: ["brought the module notes up to date from this issue"] }),
  module_knowledge_refresh_failed: () => ({ icon: "alert", did: ["could not bring the module notes up to date from this issue"] }),
};

const known = new Set<string>(ISSUE_ACTIVITY_ACTIONS);

/** Who acted, as core named them; one it could not resolve is "Another member", or "An agent" for a device. */
function actorOf(item: ActivityItem): string {
  if (item.actor?.displayName) return item.actor.type === "device" ? item.actor.displayName : personName(item.actor.displayName, "start");
  return item.actorType === "device" ? "An agent" : personName(null, "start");
}

export function activitySentence(item: ActivityItem): ActivitySentence {
  const payload = (item.payload ?? {}) as Payload;
  const said = known.has(item.action)
    ? SENTENCES[item.action as IssueActivityAction](payload)
    : { icon: "dot" as const, did: ["changed this issue"] };
  return { icon: said.icon, actor: actorOf(item), did: said.did };
}

/** The sentence as plain text, for a label or a test. */
export function sentenceText(s: ActivitySentence): string {
  return `${s.actor} ${s.did.map((p) => (typeof p === "string" ? p : p.strong)).join("")}`;
}
