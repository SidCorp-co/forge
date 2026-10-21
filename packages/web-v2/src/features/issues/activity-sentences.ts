// What an issue's Activity tab says for each event: a sentence that opens with who acted (ISS-1229
// r22). Every action core writes has its own words, keyed by the contracts vocabulary so a new one
// does not compile until it has them; a row this build cannot know still reads as a change by its
// actor, never as the code it was stored under.

import {
  type IssueActivityAction,
  type IssueUpdateField,
  ISSUE_ACTIVITY_ACTIONS,
} from "@forge/contracts/issue-vocabulary";
import { personName } from "@forge/contracts/person-name";
import type { IconName } from "@/design";
import { categoryLabel, complexityLabel, priorityLabel, statusLabel } from "./derive";
import type { ActivityItem, IssueComplexity, IssuePriority, IssueStatus } from "./types";

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

/** Each field an update can name, in the words a reader knows it by; never its stored name (ISS-1229 r23). */
const FIELD_WORDS: Record<Exclude<IssueUpdateField, MergeField>, string> = {
  title: "the title",
  description: "the description",
  priority: "the priority",
  category: "the category",
  complexity: "the complexity",
  plan: "the plan",
  acceptanceCriteria: "the acceptance criteria",
  releaseNotes: "the release note",
  sessionContext: "the agent's working notes",
  detectorKey: "what raised this issue",
  assigneeId: "who it is assigned to",
  metadata: "the branch settings",
};

/** The three fields a merge record writes together, said as the one act they are. */
type MergeField = "mergedAt" | "mergedCommitSha" | "mergedLanding";
const MERGE_FIELDS: readonly string[] = ["mergedAt", "mergedCommitSha", "mergedLanding"] satisfies MergeField[];

/** A value short enough to quote: the title, priority and category, never a body. */
const QUOTED: readonly string[] = ["title", "priority", "category", "complexity"];

/** A quoted value in the words the properties panel shows it in, never as stored (ISS-1229 r24). */
const PANEL_WORDS: Record<string, (value: string) => string> = {
  priority: (v) => priorityLabel(v as IssuePriority),
  complexity: (v) => complexityLabel(v as IssueComplexity),
  category: categoryLabel,
};

const joined = (words: string[]): string =>
  words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;

const wordsFor = (field: string): string | null =>
  Object.hasOwn(FIELD_WORDS, field) ? FIELD_WORDS[field as keyof typeof FIELD_WORDS] : null;

function edited(p: Payload): SentencePart[] {
  const fields = Array.isArray(p.fields) ? p.fields.filter((f): f is string => typeof f === "string") : [];
  const merge = fields.some((f) => MERGE_FIELDS.includes(f));
  const rest = fields.filter((f) => !MERGE_FIELDS.includes(f));
  const acts: string[] = [];
  if (merge) acts.push(text((p.after as Payload | undefined)?.mergedAt) ? "recorded the merge" : "took back the merge record");
  const [only] = rest;
  if (rest.length === 1 && only && !merge && QUOTED.includes(only)) {
    const shown = (v: string | null) => (v && PANEL_WORDS[only] ? PANEL_WORDS[only](v) : v);
    const from = shown(text((p.before as Payload | undefined)?.[only]));
    const to = shown(text((p.after as Payload | undefined)?.[only]));
    const field = wordsFor(only);
    if (field && from && to && from.length <= 40 && to.length <= 40)
      return [`changed ${field} from `, { strong: from }, " to ", { strong: to }];
    const before = p.before as Payload | undefined;
    const stoodEmpty = before !== undefined && Object.hasOwn(before, only) && !text(before[only]);
    if (field && stoodEmpty && to && to.length <= 40) return [`set ${field} to `, { strong: to }];
  }
  const named = rest.map(wordsFor).filter((w): w is string => w !== null);
  if (named.length > 0) acts.push(`changed ${joined(named)}`);
  // A field this build has no words for is a change to the issue, never its stored name.
  if (named.length < rest.length && named.length === 0) acts.push("changed this issue");
  return acts.length === 0 ? ["changed this issue"] : [joined(acts)];
}

function named(p: Payload, what: string): string {
  const name = text(p.name);
  return name ? `${what} "${name}"` : `${what === "attached" ? "attached a file" : `${what} an attachment`}`;
}

const SENTENCES: Record<
  IssueActivityAction,
  (p: Payload, viewerId: string | null) => { icon: IconName; did: SentencePart[] }
> = {
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
  "comment.mentioned": (p, viewerId) => {
    const ids = Array.isArray(p.mentionedUserIds) ? (p.mentionedUserIds as unknown[]) : [];
    const n = ids.length;
    // A mention of the reader says "you", as every other place names the reader (ISS-1229 r25).
    if (viewerId && ids.includes(viewerId)) {
      const others = n - 1;
      return {
        icon: "chat",
        did: [
          others === 0
            ? "mentioned you in a comment"
            : `mentioned you and ${others === 1 ? "another member" : `${others} other members`} in a comment`,
        ],
      };
    }
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

/** Who acted, as core named them: "You" for the reader (ISS-1229 r23); one core could not resolve is
 *  "Another member", or "An agent" for a device. */
function actorOf(item: ActivityItem, viewerId?: string | null): string {
  const userId = item.actor?.type === "user" ? item.actor.id : item.actorType === "user" ? item.actorId : null;
  if (viewerId && userId === viewerId) return "You";
  if (item.actor?.displayName) return item.actor.type === "device" ? item.actor.displayName : personName(item.actor.displayName, "start");
  return item.actorType === "device" ? "An agent" : personName(null, "start");
}

export function activitySentence(item: ActivityItem, viewerId?: string | null): ActivitySentence {
  const payload = (item.payload ?? {}) as Payload;
  const said = known.has(item.action)
    ? SENTENCES[item.action as IssueActivityAction](payload, viewerId ?? null)
    : { icon: "dot" as const, did: ["changed this issue"] };
  return { icon: said.icon, actor: actorOf(item, viewerId), did: said.did };
}

/** The sentence as plain text, for a label or a test. */
export function sentenceText(s: ActivitySentence): string {
  return `${s.actor} ${s.did.map((p) => (typeof p === "string" ? p : p.strong)).join("")}`;
}
