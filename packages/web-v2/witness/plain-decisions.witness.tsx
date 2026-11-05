// ISS-1006, the owner's three cases as drawn (owner 2026-11-05), at 1440 px light and 420 px dark:
// - peek: the steward's question on ISS-89 in the Approvals peek, read from the asker's plain text
//   alone, the answers as outcome buttons and the rest behind one closed Technical fold;
// - card, card-open, card-folded: the Ask Agent proposal card "Revision of REQ-68" above the
//   composer, its plain line and Record it / Decline, its raw fields one press away, and folded;
// - dashboard: the project Dashboard beside the Ask Agent panel open on a long thread with that card
//   waiting. The thread keeps itself at its newest output, which scrolled the whole workspace shell
//   up when it used `scrollIntoView` and left the page a top strip over white. Every dashboard stage
//   reads the layout as drawn: the shell and the window unscrolled, the page column from the top of
//   the window to its foot, the dashboard's heading in view.
//
//   pnpm --filter web-v2 witness witness/plain-decisions.witness.tsx --out <dir>

import type { ChatProposalView } from "@forge/contracts/chat-proposals";
import { needsYouDecisionSchema } from "@forge/contracts/needs-you-decisions";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { DOCK_OPEN_KEY, DOCK_ROOM_KEY, useChatDockState } from "@/features/chat-dock/dock";
import { DOCK_SIZE_KEY } from "@/features/chat-dock/dock-size";
import { DecisionPeek } from "@/features/approvals/components/approval-peek";
import { ChatDock } from "@/features/conversations/components/chat-dock";
import { ProposalCards } from "@/features/conversations/components/proposal-cards";
import { ShellTopBar } from "@/features/shell/components/shell-top-bar";
import { Route } from "@/routes/_workspace/projects/$slug/index";
import { TopBarSlotProvider } from "@/design";
import { WORKSPACE_MAIN, WORKSPACE_PAGE_COLUMN } from "@/design/templates/workspace-frame";
import { APPROVALS_PROJECT as PH, APPROVALS_READ } from "@/test/approvals-read";
import { STATUS } from "@/test/project-status";
import "./entry";
import { InRouter } from "./router";

const ROOM = "22222222-2222-4222-8222-222222222222";
const AT = "2026-11-05T03:46:00.000Z";
const SIDEBAR = 280;

const PATH = "/api/questions/q89/answer";
const answer = (id: string, label: string, effect: string, recommended = false) => ({ id, label, act: "question.answer" as const, path: PATH, body: { round: 1, optionId: id }, needsReason: !recommended, declines: false, effect, recommended });

/** The owner's case 1 as forge-dev drew it, with the plain text the steward is now taught to write. */
const PEEK = needsYouDecisionSchema.parse({
  id: "question:q89",
  group: "answer",
  area: "questions",
  entity: "question",
  key: "1152a5c3-0abf-4685-854f-d0cee04f7447",
  title: "A question a run asked",
  opens: { kind: "requirement", key: "REQ-9" },
  question: "Open it, merge it into ISS-98, keep it as a draft, or drop it?",
  changes: "Whether draft ISS-89 becomes open work",
  impact: "REQ-9 waits on this; only open work is planned and built.",
  recommended: { answerId: "steward.open", why: "ISS-89 now links agreed REQ-9 and has checkable criteria traced to BC-2 and BC-5; opening it lets its dependent work proceed when its blockers settle.", by: "steward" },
  noRecommendation: null,
  answers: [
    answer("steward.open", "Open it: admit it for work", "Opens ISS-89 as you; its driver plans it from the requirement and criteria the steward prepared.", true),
    answer("steward.merge:ISS-98", "Merge it into ISS-98", "Copies ISS-89's text to ISS-98 as a comment, then drops ISS-89, as you."),
    answer("steward.keep", "Keep it as a draft", "Keeps ISS-89 as a draft until its standing moves, with your reason."),
    answer("steward.drop", "Drop it: it is not work", "Drops ISS-89 as you, with your reason."),
  ],
  touchedAt: "2026-10-31T09:00:00.000Z",
  stuck: false,
  dueAt: null,
  topic: "question",
  proposal: null,
  evidence: { requirement: { key: "REQ-9", title: "Orbit publishes the admin API contract", revision: 3 }, criteria: { count: 2, codes: ["BC-2", "BC-5"] } },
  plain: "Hai mươi bốn màn hình đơn hàng sẽ có kiểu dữ liệu rõ ràng để Orbit công bố.\nViệc của Orbit đang chờ bước này.\nTôi khuyên mở việc này ngay.", // i18n-allow: the plain text in the owner's language
});

/** The owner's case 2: "Revision of REQ-68" as forge-dev held it, with its agent's plain line. */
const CARD: ChatProposalView = {
  id: "33333333-3333-4333-8333-333333333333",
  conversationId: ROOM,
  kind: "requirement_revision",
  status: "pending",
  summary: {
    title: "Revision of REQ-68",
    lines: [
      "baseRevision: 1",
      'spec: {"goal":"Problem: people re-review, wait and repeat decisions, or cannot tell what must be decided because approval screens bury the action in dense, low-value copy.","personas":["Product owner","BA","Steward agent"]}',
      "kind: screen",
      "tldr: Approvals must lead with one plain-language decision and its consequence, then offer concise choices.",
      "changeSummary: Make the Approvals decision surface readable and action-led.",
      "writtenLang: en",
    ],
    relates: ["REQ-68"],
    plain: "Mỗi quyết định trong Duyệt mở ra bằng một dòng dễ hiểu. Tôi khuyên ghi lại bản sửa này.", // i18n-allow: the plain line in the owner's language
  },
  proposedTo: { userId: "44444444-4444-4444-8444-444444444444", label: "Owner" },
  canDecide: true,
  agreedVia: null,
  agreedWords: null,
  record: null,
  failure: null,
  createdAt: AT,
  decidedAt: null,
};

const msg = (seq: number) => ({
  id: `m${seq}`,
  seq,
  role: seq % 2 ? "user" : "assistant",
  authorUserId: null,
  authorLabel: null,
  content: seq % 2 ? `Question ${seq}: what waits on me today, and what do I approve first?` : `Answer ${seq}: three decisions wait on you. The release approval is the oldest, then the two requirement revisions. Each one says what changes for your users and what I recommend, so you can decide from the line alone.`,
  blocks: null,
  silenceReason: null,
  createdAt: AT,
});
const ROOM_ROW = { id: ROOM, adapter: "web", externalId: ROOM, mode: "agent", title: "What do I approve here?", updatedAt: AT, archivedAt: null, ecosystemId: null, kind: null, threadStatus: "done", subjectKey: null, projectId: PH, pinned: false, shape: "direct", participants: [], scope: [PH], scopeProjects: [{ id: PH, name: "Hop Clinic API", slug: "hop" }], canChangeMembership: false };
const ROOM_DETAIL = { ...ROOM_ROW, messages: Array.from({ length: 40 }, (_, i) => msg(i + 1)), windows: [], agentTurns: [], agentMode: { available: true, reason: null }, questionnaires: [] };

const READS: [RegExp, () => unknown][] = [
  [/^\/projects$/, () => [{ id: PH, slug: "hop", name: "Hop Clinic API", role: "admin", orgId: null, orgRole: null }]],
  [/\/needs-you\/decisions$/, () => APPROVALS_READ],
  [/^\/projects\/[^/]+\/status$/, () => ({ ...STATUS, projectId: PH })],
  [/\/metrics\/health$/, () => ({ days: 30, series: [], totals: { throughput: 0, stepFailures: 0, retries: 0, interventions: 0 }, previous: { throughput: 0, stepFailures: 0, retries: 0, interventions: 0 } })],
  [/^\/projects\/[^/]+\/requirements$/, () => ({ requirements: [] })],
  [/^\/projects\/[^/]+\/feedback$/, () => ({ feedback: [] })],
  [/\/forecast\/requirements$/, () => ({ projectId: PH, requirements: [] })],
  [/\/forecast\/feedback$/, () => ({ projectId: PH, items: [] })],
  [/\/releases$/, () => ({ releases: [], counts: {}, approvalRequired: false, production: { ok: true, url: null }, landings: [] })],
  [/\/workflows$/, () => ({ workflows: [], returned: 0 })],
  [/\/workflow-templates$/, () => ({ templates: [] })],
  [/\/config$/, () => ({ declared: true, revision: 1, document: { project: { description: "The clinic back office." } } })],
  [/\/modules\/rollup$/, () => ({ modules: [] })],
  [/\/steward-budget$/, () => ({ day: AT, resumesAt: AT, handoff: { gatewayTurns: { spent: 0, of: 80 }, runnerJobs: { spent: 0, of: 4 } }, sweep: { gatewayTurns: { spent: 0, of: 120 }, runnerJobs: { spent: 0, of: 6 } }, paced: 0, quiet: null })],
  [/^\/memory\/entries$/, () => ({ items: [], counts: { live: 0, superseded: 0, archived: 0 }, returned: 0, total: 0, limit: 100 })],
  [/^\/conversations$/, () => ({ items: [ROOM_ROW], total: 1 })],
  [new RegExp(`^/conversations/${ROOM}$`), () => ROOM_DETAIL],
  [new RegExp(`^/conversations/${ROOM}/proposals$`), () => ({ proposals: [CARD] })],
];
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
window.fetch = async (input: RequestInfo | URL) => {
  const url = new URL(String(input), "http://forge.test");
  const path = url.pathname.replace(/^\/api/, "");
  for (const [pattern, reply] of READS) if (pattern.test(path)) return json(reply());
  return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "none" } }), { status: 404, headers: { "content-type": "application/json" } });
};

window.localStorage.clear();
window.localStorage.setItem(DOCK_OPEN_KEY, JSON.stringify(true));
window.localStorage.setItem(DOCK_ROOM_KEY, JSON.stringify({ [PH]: ROOM }));
// the owner's panel was a custom width beside the page
window.localStorage.setItem(DOCK_SIZE_KEY, JSON.stringify("large"));

type Scene = "peek" | "card" | "dashboard";
const at: { set: (s: Scene) => void } = { set: () => {} };
const Dashboard = Route.options.component as () => React.ReactNode;
const peekState = { open: PEEK.id, position: { at: 1, of: 1 }, set: () => {}, move: () => {} };

function Shell() {
  const dock = useChatDockState(PH);
  const column = useRef<HTMLDivElement>(null);
  return (
    <TopBarSlotProvider>
      {/* as src/routes/_workspace/route.tsx draws it */}
      <div className="flex h-dvh overflow-hidden bg-shell" data-shell data-witness="shell">
        <div className="hidden h-full flex-none bg-surface md:block" style={{ width: SIDEBAR }} data-witness="sidebar" />
        <div ref={column} className={WORKSPACE_PAGE_COLUMN} data-page data-witness="page">
          <ShellTopBar chatOpen={dock.open} onToggleChat={dock.toggle} />
          <main className={WORKSPACE_MAIN} data-witness="main">
            <Dashboard />
          </main>
        </div>
        <ChatDock dock={dock} page={column} />
      </div>
    </TopBarSlotProvider>
  );
}

function Scenes() {
  const [scene, setScene] = useState<Scene>("peek");
  at.set = setScene;
  if (scene === "dashboard") return <Shell />;
  return (
    <div className="flex min-h-dvh justify-end bg-app">
      <div className="flex w-full flex-col border-l border-line bg-surface" style={{ maxWidth: 520, minHeight: "100dvh" }} data-witness="frame">
        {scene === "peek" ? (
          <DecisionPeek d={PEEK} peek={peekState} full={{ href: "/x", origin: null }} slug="hop" noun="Question" typing={null} onType={() => {}} onPress={() => {}} />
        ) : (
          <>
            <div className="flex-1 p-4 text-13 text-muted">{msg(2).content}</div>
            <ProposalCards conversationId={ROOM} threadLength={40} />
          </>
        )}
      </div>
    </div>
  );
}

function App() {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } }));
  return (
    <QueryClientProvider client={client}>
      <InRouter at="/projects/hop" pattern="/projects/$slug">
        <Scenes />
      </InRouter>
    </QueryClientProvider>
  );
}

const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const KEY = /\b(?:ISS|REQ|BC)-\d+/;
const dark = () => window.innerWidth < 600;
const theme = () => {
  const t = dark() ? "dark" : "light";
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};

async function until(test: () => boolean, what: string): Promise<string[]> {
  for (let i = 0; i < 60; i++) {
    if (test()) return [];
    await pause(100);
  }
  return [`${what} was never drawn`];
}

/** The page beside the panel as drawn: nothing scrolled the shell or the window, and the page fills it. */
function dashboardWrongs(): string[] {
  const wrong: string[] = [];
  const shell = q("[data-witness=shell]");
  const page = q("[data-witness=page]");
  const main = q("[data-witness=main]");
  if (!shell || !page || !main) return ["the shell is not drawn"];
  if (main.scrollTop !== 0) wrong.push(`the dashboard itself is scrolled ${main.scrollTop} px, which nobody asked for`);
  if (shell.scrollTop !== 0) wrong.push(`the workspace shell is scrolled ${shell.scrollTop} px up, so the page reads as a strip`);
  // nothing laid out past the shell's foot or the window's, which a script scrolling its way to the thread's end would reveal
  if (shell.scrollHeight > shell.clientHeight + 1) wrong.push(`the workspace shell holds ${shell.scrollHeight} px in ${shell.clientHeight}, so it can be scrolled`);
  const tall = document.documentElement.scrollHeight;
  if (tall > window.innerHeight + 1) wrong.push(`the document is ${tall} px tall in a ${window.innerHeight} px window`);
  const scrolled = document.scrollingElement?.scrollTop ?? 0;
  if (scrolled !== 0) wrong.push(`the window is scrolled ${scrolled} px`);
  const r = page.getBoundingClientRect();
  if (Math.round(r.top) !== 0) wrong.push(`the page column starts at ${Math.round(r.top)} px, not at the window's top`);
  if (Math.round(r.bottom) < window.innerHeight - 1) wrong.push(`the page column ends at ${Math.round(r.bottom)} px of a ${window.innerHeight} px window`);
  const heading = q("[data-witness=page] h1");
  const h = heading?.getBoundingClientRect();
  if (!h || h.bottom <= 0 || h.top >= window.innerHeight) wrong.push("the dashboard's heading is out of view");
  return wrong;
}

window.__witness = {
  cases: [
    { name: "light-1440", width: 1440 },
    { name: "dark-420", width: 420 },
  ],
  ready: () => Boolean(q("[data-testid=approval-peek]")),
  stages: [
    {
      name: "peek",
      run: () => {
        theme();
        const decide = q("[data-testid=approval-peek-decide]");
        if (!decide) return ["the peek draws no plain decision"];
        return KEY.test(decide.innerText) ? [`the plain decision shows a key: ${decide.innerText.match(KEY)?.[0]}`] : [];
      },
    },
    {
      name: "card",
      run: async () => {
        at.set("card");
        const missing = await until(() => Boolean(q("[data-testid=proposal-plain]")), "the card's plain line");
        const card = q("[data-testid=proposal-card]");
        return [...missing, ...(card && KEY.test(card.innerText) ? ["the folded-in card shows a key before its fold is opened"] : [])];
      },
    },
    {
      name: "card-open",
      run: async () => {
        q("[data-testid=proposal-technical] button")?.click();
        return until(() => (q("[data-testid=proposal-lines]")?.innerText ?? "").includes("baseRevision"), "the card's technical lines");
      },
    },
    {
      name: "card-folded",
      run: async () => {
        q("[data-testid=proposal-fold]")?.click();
        return until(() => q("[data-testid=proposal-card]")?.dataset.folded === "true", "the folded card");
      },
    },
    {
      name: "dashboard",
      run: async () => {
        at.set("dashboard");
        const missing = await until(() => Boolean(q("[data-witness=page] h1")) && Boolean(q("[data-testid=proposal-card]")), "the dashboard beside the panel's thread and card");
        // the thread pins itself to its newest output once its messages and card are drawn
        await pause(1500);
        return [...missing, ...dashboardWrongs()];
      },
    },
  ],
};

const root = document.getElementById("root");
if (!root) throw new Error("the witness page has no #root to mount into");
createRoot(root).render(<App />);
