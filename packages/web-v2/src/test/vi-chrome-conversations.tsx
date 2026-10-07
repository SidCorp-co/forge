import type { QueryKey } from "@tanstack/react-query";
import { fireEvent } from "@testing-library/react";
import { BoardPanel } from "@/features/conversations/board/board-panel";
import { AddAgentDialog, AddPersonDialog } from "@/features/conversations/components/add-member-dialog";
import { ConversationChat } from "@/features/conversations/components/conversation-chat";
import { ConversationMembers } from "@/features/conversations/components/conversation-members";
import { ScopeNotice } from "@/features/conversations/components/scope-notice";
import { UiActionCard, type UiCallRecord } from "@/features/conversations/ui-actions/use-ui-actions";
import { ThreadSub } from "@/features/onboarding/components/thread-sub";
import { boardStore } from "@/features/board/board-store";
import { ActorChip, PersonChip } from "@/design";
import { AgentChip } from "@/design/patterns/person-chip";
import { Seeded } from "./vi-chrome-requirements";

// The conversation room of the Development space for the vi walking test: a room about two projects
// (its membership sentences and the refusal to send), its thread with every silence a window can
// close on, the member roster and both add dialogs, the thread line, the assistant's UI-action cards
// and the board. Names and messages are placeholder words (what a person or agent wrote stays as written).

const P = "p-conv";
const OTHER = "p-other";
const AT = "2026-10-07T08:00:00.000Z";
const noop = () => {};
const projects = [
  { id: P, slug: "hop", name: "Hop", role: "admin", orgId: null },
  { id: OTHER, slug: "kho", name: "Kho", role: "admin", orgId: null },
];

const participants = [
  { id: "pa1", kind: "handle", userId: "ua1", projectId: P, label: "tro-ly-hop", displayName: "tro-ly-hop", reachable: true },
  { id: "pa2", kind: "handle", userId: "ua2", projectId: OTHER, label: "tro-ly-kho", displayName: "tro-ly-kho", reachable: false },
  { id: "pp1", kind: "person", userId: "u1", projectId: null, label: null, displayName: "Lan", reachable: null },
  { id: "pp2", kind: "person", userId: "u2", projectId: null, label: null, displayName: null, reachable: null },
];
const membership = (over: Record<string, unknown> = {}) => ({
  shape: "group",
  participants,
  scope: [P, OTHER],
  scopeProjects: [projects[0], projects[1]].map((p) => ({ id: (p as { id: string }).id, name: (p as { name: string }).name, slug: (p as { slug: string }).slug })),
  canChangeMembership: true,
  ...over,
});

const base = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  adapter: "web",
  externalId: id,
  mode: "assistant",
  title: `Phong ${id}`,
  updatedAt: AT,
  archivedAt: null,
  ecosystemId: null,
  kind: null,
  threadStatus: null,
  subjectKey: null,
  projectId: P,
  pinned: false,
  ...membership(),
  ...over,
});

const msg = (seq: number, role: string, over: Record<string, unknown> = {}) => ({ id: `m${seq}`, seq, role, authorUserId: null, authorLabel: null, content: `Tin nhan ${seq}`, blocks: null, silenceReason: null, createdAt: AT, ...over });
const win = (id: string, lastSeq: number, decision: string | null, over: Record<string, unknown> = {}) => ({ id, firstSeq: lastSeq, lastSeq, closedAt: decision ? AT : null, decision, decisionDetail: null, ...over });

const MESSAGES = [
  msg(1, "user"),
  msg(2, "assistant", { silenceReason: "not-mentioned" }),
  msg(3, "user"),
  msg(4, "assistant", { silenceReason: "nothing-to-say" }),
  msg(5, "user"),
  msg(6, "user"),
  msg(7, "user"),
  msg(8, "user"),
  msg(9, "user"),
  msg(10, "user"),
  msg(11, "user"),
  msg(12, "user"),
  msg(13, "user"),
  msg(14, "user"),
  msg(15, "user"),
  msg(16, "user"),
  msg(17, "user"),
  msg(18, "user"),
  msg(19, "user"),
  msg(20, "assistant", { silenceReason: "something-else" }),
];
const WINDOWS = [
  win("w5", 5, "nothing-to-say"),
  win("w6", 6, "guard-backoff"),
  win("w7", 7, "guard-agent-loop"),
  win("w8", 8, "guard-dormant"),
  win("w9", 9, "authority-refused"),
  win("w10", 10, "unreachable"),
  win("w11", 11, "undetermined"),
  win("w12", 12, "stopped"),
  win("w13", 13, "unreachable", { decisionDetail: { code: "ASSISTANT_REPLY_UNDELIVERED", reason: "r", undeliveredReply: "Cau tra loi chua gui" } }),
  win("w14", 14, "unreachable", { decisionDetail: { undeliveredReply: "Cau tra loi khac" } }),
  win("w15", 15, "unreachable", { decisionDetail: { code: "ASSISTANT_TURN_TIMED_OUT", reason: "r" } }),
  win("w16", 16, "handed-off", { decisionDetail: { handedTo: "onboarding-job", reason: "r" } }),
  win("w17", 17, "handed-off"),
  win("w18", 18, "handed-off"),
  win("w19", 19, "handed-off"),
  win("w20", 20, null),
];
const TURNS = [
  { windowId: "w18", sessionId: "s1", state: "dispatched", reason: null },
  { windowId: "w19", sessionId: "s2", state: "failed", reason: "r" },
  { windowId: "w17", sessionId: "s3", state: "running", reason: null },
];

const detail = (id: string, over: Record<string, unknown> = {}) => ({ ...base(id, over), messages: MESSAGES, windows: WINDOWS, agentTurns: TURNS, agentMode: { available: true, reason: null }, questionnaires: [] });

const data = (): [QueryKey, unknown][] => [
  [["projects"], projects],
  [["conversations", "c-two"], detail("c-two", { kind: "requirement", threadStatus: "waiting_on_you" })],
  [["conversations", "c-one"], detail("c-one", { shape: "direct", scope: [P], scopeProjects: [{ id: P, name: "Hop", slug: "hop" }], participants: [participants[0], participants[2]], messages: [msg(1, "user")], windows: [], agentTurns: [], kind: "onboarding", threadStatus: "in_progress" })],
  [["conversations", "c-empty"], { ...detail("c-empty"), messages: [], windows: [], agentTurns: [], agentMode: { available: false, reason: "khong co may" } }],
  [["conversations", "c-two", "candidates"], {
    people: [{ userId: "u3", displayName: "Minh", email: "minh@hop.vn" }, { userId: "u4", displayName: null, email: "an@hop.vn" }],
    handles: [{ userId: "ua3", handle: "tro-ly-ba", project: { id: "p3", name: "Ba", slug: "ba" }, losesReaders: ["Lan", "Minh"] }, { userId: null, handle: "tro-ly-bon", project: { id: P, name: "Hop", slug: "hop" }, losesReaders: ["Lan"] }],
  }],
  [["conversations", "c-one", "candidates"], { people: [{ userId: "u3", displayName: "Minh", email: "minh@hop.vn" }], handles: [{ userId: "ua3", handle: "tro-ly-ba", project: { id: "p3", name: "Ba", slug: "ba" }, losesReaders: [] }] }],
  [["onboarding", P], {
    onboarding: null,
    hint: null,
    firstRequirements: { openBatch: { id: "b1", round: 1, open: 3, postedAt: AT, dueAt: AT, overdue: true, waitingDays: 5 } },
  }],
];

const wrap = (children: React.ReactNode) => <Seeded data={data()}>{children}</Seeded>;
const clickNth = (selector: string, n = 0) => () => {
  const hit = document.querySelectorAll(selector)[n];
  if (!hit) throw new Error(`nothing to click at ${selector}`);
  fireEvent.click(hit);
};

const record = (over: Partial<UiCallRecord> & { reading: UiCallRecord["reading"] }): UiCallRecord => ({ callId: "k", entryId: "e", ...over });
const OK = (summary: string, chips: { field: "status" | "priority" | "createdBy" | "assignee" | "text"; label: string }[] = []) => ({ ok: true as const, summary, undo: noop, chips });
const navigate = { kind: "action", action: { name: "ui.navigate", params: { route: "issues" } } } as UiCallRecord["reading"];

export const CONVERSATION_SCREENS = [
  { name: "Conversation · two projects", render: () => wrap(<ConversationChat projectId={P} conversationId="c-two" />) },
  { name: "Conversation · one-to-one onboarding", render: () => wrap(<ConversationChat projectId={P} conversationId="c-one" />) },
  { name: "Conversation · empty", render: () => wrap(<ConversationChat projectId={P} conversationId="c-empty" />) },
  { name: "Conversation · members", render: () => wrap(<ConversationChat projectId={P} conversationId="c-two" />), act: clickNth('button[aria-label]:not([aria-haspopup])', 0) },
  { name: "Conversation · roster", render: () => wrap(<ConversationMembers conversationId="c-two" room={membership() as never} canChange open onClose={noop} />) },
  { name: "Conversation · roster read only", render: () => wrap(<ConversationMembers conversationId="c-one" room={membership({ shape: "direct", participants: [participants[2]], scopeProjects: [] }) as never} canChange={false} open onClose={noop} />) },
  { name: "Conversation · add agent", render: () => wrap(<AddAgentDialog conversationId="c-two" room={membership() as never} open onClose={noop} />) },
  { name: "Conversation · add agent confirmation", render: () => wrap(<AddAgentDialog conversationId="c-two" room={membership() as never} open onClose={noop} />), act: clickNth("button.flex.w-full", 0) },
  { name: "Conversation · add agent to a direct room", render: () => wrap(<AddAgentDialog conversationId="c-one" room={base("c-one", { shape: "direct", scopeProjects: [{ id: P, name: "Hop", slug: "hop" }], participants: [participants[0], participants[2]] }) as never} open onClose={noop} />), act: clickNth("button.flex.w-full", 0) },
  { name: "Conversation · add person", render: () => wrap(<AddPersonDialog conversationId="c-two" room={membership() as never} open onClose={noop} />) },
  { name: "Conversation · add person confirmation", render: () => wrap(<AddPersonDialog conversationId="c-two" room={membership() as never} open onClose={noop} />), act: clickNth("button.flex.w-full", 0) },
  { name: "Conversation · add person to a direct room", render: () => wrap(<AddPersonDialog conversationId="c-one" room={membership({ shape: "direct" }) as never} open onClose={noop} />), act: clickNth("button.flex.w-full", 0) },
  { name: "Conversation · scope notice", render: () => wrap(<><ScopeNotice room={membership() as never} /><ScopeNotice room={{ scopeProjects: [{ id: P, name: "Hop", slug: "hop" }] }} /><ScopeNotice room={{ scopeProjects: [] }} /></>) },
  {
    name: "Conversation · thread line",
    render: () => wrap(
      <>
        <ThreadSub kind="requirement" status="waiting_on_you" />
        <ThreadSub kind="onboarding" status="in_progress" projectId={P} />
        <ThreadSub kind="first_requirements" status="done" projectId={P} />
        <ThreadSub kind={null} status="done" />
      </>,
    ),
  },
  {
    name: "Conversation · assistant UI cards",
    render: () => (
      <div>
        <UiActionCard record={record({ reading: navigate, outcome: OK("Da mo danh sach") })} onUndo={noop} onClear={noop} />
        <UiActionCard record={record({ reading: navigate, outcome: OK("Da loc: muc cao", [{ field: "priority", label: "Uu tien: cao" }, { field: "createdBy", label: "Do toi tao" }]) })} onUndo={noop} onClear={noop} />
        <UiActionCard record={record({ reading: navigate, outcome: OK("Da mo danh sach"), undone: true })} onUndo={noop} onClear={noop} />
        <UiActionCard record={record({ reading: navigate })} onUndo={noop} onClear={noop} />
        <UiActionCard record={record({ reading: navigate, outcome: { ok: false, code: "UI_ACTION_UNAVAILABLE", message: "Khong the ap dung" } })} onUndo={noop} onClear={noop} />
        <UiActionCard record={record({ reading: { kind: "refused", name: "ui.select", code: "UI_ACTION_INVALID", message: "Khong hop le" } })} onUndo={noop} onClear={noop} />
      </div>
    ),
  },
  {
    name: "Conversation · board",
    render: () => {
      boardStore.load({ v: 1, title: "So do", shapes: [{ id: "a", type: "box", x: 0, y: 0, w: 10, h: 10 }] } as never);
      return wrap(<BoardPanel projectId={P} issueKey="ISS-1" />);
    },
  },
  {
    name: "Conversation · board empty",
    render: () => {
      boardStore.load({ v: 1, shapes: [] } as never);
      return wrap(<BoardPanel projectId={P} />);
    },
  },
  {
    name: "Actor chips",
    render: () => (
      <>
        <PersonChip name="Lan" />
        <AgentChip name="tro-ly" />
        <ActorChip name="Minh" kind="human" />
        <ActorChip name="tro-ly-hai" kind="agent" />
      </>
    ),
  },
];
