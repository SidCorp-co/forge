import { ThreadsScreen } from "@/features/ecosystem/components/threads-screen";
import type { RegisterRow, WorkspaceRead } from "@/features/ecosystem/types";
import { Seeded } from "./vi-chrome-requirements";

// The Threads inbox across ecosystems (/ecosystems/threads), with a row in each kind of standing, a
// draft a master wrote and a held thread, so every pill and line it draws is read.

const row = (over: Partial<RegisterRow>): RegisterRow & { ecosystem: string } => ({
  number: "CN-1",
  type: "change-notice",
  subject: "Cập nhật API đơn hàng", // i18n-allow: Vietnamese text under test
  from: "p2",
  to: ["p1"],
  inReplyTo: null,
  thread: "t1",
  state: "published",
  authoredBy: { kind: "agent" } as RegisterRow["authoredBy"],
  publishedAt: "2026-10-07T00:00:00Z",
  dueBy: "2026-10-01",
  recipients: [],
  open: true,
  overdue: true,
  owner: ["p1"],
  hold: null,
  ecosystem: "e1",
  ...over,
});

const read: WorkspaceRead = {
  ecosystems: [{ id: "e1", slug: "eco-a", name: "Eco A", purpose: null, code: "EA", steward: { id: "o1", name: null, mine: true }, visibility: "all", responseDays: {} as WorkspaceRead["ecosystems"][number]["responseDays"], gate: {} as WorkspaceRead["ecosystems"][number]["gate"], members: ["p1", "p2"] }],
  invitations: [],
  threads: [
    row({}),
    row({ number: "RFI-2", type: "rfi", overdue: false, dueBy: "2026-12-01" }),
    row({ number: "CR-3", type: "change-request", overdue: false, dueBy: null }),
    row({ number: "CN-4", from: "p1", to: ["p2"], owner: ["p2"], overdue: false }),
  ],
  drafts: [{ id: "d1", ecosystem: "e1", from: "p1", inReplyTo: "CN-1", type: "acknowledgement", state: "draft", authoredBy: { kind: "agent" } as WorkspaceRead["drafts"][number]["authoredBy"], gate: null, gateQuestionId: null }],
  projects: [{ id: "p1", slug: "hop", name: "HOP" }, { id: "p2", slug: "shop", name: "Shop" }] as WorkspaceRead["projects"],
  mine: ["p1"],
};

const views = ["needs-me", "waiting", "overdue", "held", "working", "answered", "closed"];

export const THREADS_SCREENS = [
  ...views.map((view) => ({
    name: `Threads · ${view}`,
    render: () => (
      <Seeded data={[[["ecosystem", "mine"], read]]}>
        <ThreadsScreen filters={{ view, ecosystem: null, project: null, type: null }} onParam={() => {}} />
      </Seeded>
    ),
  })),
  { name: "Threads · unknown view", render: () => <Seeded data={[[["ecosystem", "mine"], read]]}><ThreadsScreen filters={{ view: "bogus", ecosystem: null, project: null, type: null }} onParam={() => {}} /></Seeded> },
  { name: "Threads · no ecosystem", render: () => <Seeded data={[[["ecosystem", "mine"], { ...read, ecosystems: [], threads: [] }]]}><ThreadsScreen filters={{ view: null, ecosystem: null, project: null, type: null }} onParam={() => {}} /></Seeded> },
  { name: "Threads · loading", render: () => <Seeded data={[]}><ThreadsScreen filters={{ view: null, ecosystem: null, project: null, type: null }} onParam={() => {}} /></Seeded> },
];
