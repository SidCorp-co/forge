// ISS-1184's bell, apart from screen-copy-rest.witness.tsx so neither coordinates more modules than
// archmap allows: a stuck-work notice reads in plain words, never "Pipeline wedge: claim hop miss on
// session", at 1440 by 900 and 390 by 844, light then dark. `VITE_WITNESS_BEFORE=1` draws the old
// notice. Each stage prints `WORDS bell <theme> <width> <n> whole <m>` (witness/first-screen.ts).
//
//   [VITE_WITNESS_BEFORE=1] pnpm --filter web-v2 witness witness/screen-copy-bell.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { NotificationsMenu, TopBarSlotProvider } from "@/design";
import { toNotificationItem } from "@/features/notifications/map";
import type { NotificationRow } from "@/features/notifications/types";
import { ShellTopBar } from "@/features/shell/components/shell-top-bar";
import { firstScreenWords } from "./first-screen";
import "./entry";
import { InRouter } from "./router";

const BEFORE = import.meta.env.VITE_WITNESS_BEFORE === "1";
const P = "d1bb4907-74d9-4228-85ff-76121523af7d";
const AT = "2026-11-09T14:20:00.000Z";

// two stuck-work notices queue-hop.ts and the zombie reaper write
const SESSION = "5b0c7a52-1f43-4c55-9d43-0d3c1a7f0e11";
const notice = (id: string, title: string, body: string): NotificationRow =>
  ({
    id,
    notificationId: `n-${id}`,
    projectId: P,
    type: "pipeline_wedge",
    kind: "condition",
    tier: "ticket",
    title,
    body,
    readAt: null,
    groupKey: null,
    resolvedNotice: false,
    members: 1,
    openMembers: 1,
    severity: "warning",
    issueId: null,
    secondaryIssueId: null,
    agentSessionId: SESSION,
    createdAt: AT,
    subject: null,
    project: { id: P, slug: "forge", name: "Forge" },
    line: title,
  }) as unknown as NotificationRow;
const NOTICES: NotificationRow[] = BEFORE
  ? [
      notice("d1", "Pipeline wedge: claim hop miss on session", `WHERE: claim hop, session ${SESSION}\nWHY: no worker claimed the session within the queue timeout\nWHAT: Check that an online runner is bound to this project.`),
      notice("d2", "Pipeline wedge: heartbeat hop miss on job", "WHERE: heartbeat hop, job 0b3f\nWHY: the job's lease expired with no heartbeat\nWHAT: The job is retried."),
    ]
  : [
      notice("d1", "An agent session was never picked up by a machine", "No worker claimed the session within the queue timeout.\nNext: Check that an online runner is bound to this project."),
      notice("d2", "A job stopped answering", "The job's lease expired with no heartbeat.\nNext: The job is retried."),
    ];
const NEVER = /Pipeline wedge|hop miss|WHERE:|WHY:|WHAT:/;

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
window.fetch = async (input: RequestInfo | URL) => {
  const path = new URL(String(input), "http://witness.test").pathname.replace(/^\/api/, "");
  if (path === "/projects") return json([{ id: P, slug: "forge", name: "Forge", role: "admin", orgId: null, orgRole: null }]);
  // a read no fixture answers stays in flight, drawing its loading state
  console.log(`UNANSWERED ${path}`);
  return new Promise<Response>(() => {});
};

const replace = window.history.replaceState.bind(window.history);
window.history.replaceState = (data, unused, url) => {
  try {
    replace(data, unused, url);
  } catch {
    /* the page stays at its file:// address; the fixtures read nothing from it */
  }
};

const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};

window.__witness = {
  cases: [
    { name: "wide-1440", width: 1440, height: 900 },
    { name: "narrow-390", width: 390, height: 844 },
  ],
  ready: () => Boolean(q("[data-testid=bell-witness]")),
  stages: (["light", "dark"] as const).map((t) => ({
    name: `bell-${t}`,
    run: async () => {
      theme(t);
      window.scrollTo(0, 0);
      await pause(900);
      const wrong: string[] = [];
      const root = document.documentElement;
      if (root.scrollWidth > root.clientWidth) wrong.push(`the page scrolls sideways: ${root.scrollWidth} px wide in a ${root.clientWidth} px window`);
      const page = q("[data-witness=page]") as HTMLElement;
      const { count, words } = firstScreenWords(page);
      const whole = firstScreenWords(page, { whole: true });
      console.log(`WORDS bell ${t} ${window.innerWidth} ${count} whole ${whole.count} :: ${words.join(" ")}`);
      if (BEFORE) return [];
      const said = whole.words.join(" ");
      if (NEVER.test(said)) wrong.push(`a stuck-work notice reads the detector's labels: "${said.match(NEVER)?.[0]}"`);
      return wrong;
    },
  })),
};

const root = document.getElementById("root");
if (!root) throw new Error("the witness page has no #root to mount into");
createRoot(root).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } })}>
    <InRouter at="/projects/forge" pattern="/projects/$slug">
      <TopBarSlotProvider>
        <div className="min-h-screen bg-app text-fg" data-witness="page">
          <ShellTopBar chatOpen={false} onToggleChat={() => {}} />
          <div className="mx-auto max-w-[420px] p-4" data-testid="bell-witness">
            <NotificationsMenu items={NOTICES.map((r) => toNotificationItem(r, undefined, "en"))} onMarkAllRead={() => {}} />
          </div>
        </div>
      </TopBarSlotProvider>
    </InRouter>
  </QueryClientProvider>,
);
