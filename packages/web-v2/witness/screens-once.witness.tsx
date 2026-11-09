// The screens ISS-1179 and ISS-1180 change, drawn from forge-dev's own reads of 2026-11-09 (trimmed into
// screens-once.fixture.json) at 1440 by 900 and 390 by 844, light then dark:
// - REQ-66, accepted by decision: its Acceptance checklist reads waived, never "2 open", beside its
//   "Nothing owed"; its untraced Feedback lifecycle folds to its name;
// - REQ-12, in delivery with criteria not passing: Mark delivered is held, never the primary;
// - #Forge-Communicate: who answers the room first and whether it is live, an empty record reading
//   "Not recorded yet" beside the act that fills it, and the way back to Channels.
// Each stage prints `WORDS <screen> <theme> <width> <n>` for the words on the first screen
// (witness/first-screen.ts) and fails where the screen says what the change removed.
//
//   pnpm --filter web-v2 witness witness/screens-once.witness.tsx --out <dir>

import type { ChannelView } from "@forge/contracts/support-channel";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { TopBarSlotProvider } from "@/design";
import { ChannelScreen } from "@/features/channels";
import { RequirementScreen } from "@/features/requirements/components/requirement-screen";
import { ShellTopBar } from "@/features/shell/components/shell-top-bar";
import { firstScreenWords } from "./first-screen";
import "./entry";
import { InRouter } from "./router";
import FIXTURE from "./screens-once.fixture.json";

const P = "d1bb4907-74d9-4228-85ff-76121523af7d";

const COMMUNICATE: ChannelView = {
  rid: "6a95265c70ac333f6394dcfc",
  name: "Forge-Communicate",
  members: 0,
  rules: 0,
  commonIssues: 0,
  agent: { kind: "channel", role: "operations", channel: "6a95265c70ac333f6394dcfc", answeredBy: "forge", box: "sid-xeon-1-dev", address: "forge-session:5b0c7a52-1f43-4c55-9d43-0d3c1a7f0e11", terminal: null, since: "2026-11-04T06:12:00.000Z" },
  memberRows: [],
  ruleRows: [],
  commonIssueRows: [],
  routes: [
    { route: "forge", members: [] },
    { route: "technical", members: [] },
    { route: "product", members: [] },
  ],
};

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const WORKFLOWS = FIXTURE.workflows as { workflowId: string }[];
window.fetch = async (input: RequestInfo | URL) => {
  const path = new URL(String(input), "http://witness.test").pathname.replace(/^\/api/, "");
  if (path === "/projects") return json([{ id: P, slug: "forge", name: "Forge", role: "admin", orgId: null }]);
  if (path === `/projects/${P}/requirements/REQ-66`) return json(FIXTURE.req66);
  if (path === `/projects/${P}/requirements/REQ-12`) return json(FIXTURE.req12);
  if (path === `/projects/${P}/requirements/REQ-66/checklist`) return json(FIXTURE.req66Checklist);
  if (path === `/projects/${P}/requirements/REQ-12/checklist`) return json(FIXTURE.req12Checklist);
  if (path === `/projects/${P}/workflow-templates`) return json(FIXTURE.templates);
  const wf = WORKFLOWS.find((w) => path === `/projects/${P}/workflows/${w.workflowId}`);
  if (wf) return json(wf);
  if (path === `/projects/${P}/support/channels/${COMMUNICATE.rid}`) return json({ channel: COMMUNICATE });
  // a read no fixture answers stays in flight, drawing its loading state
  return new Promise<Response>(() => {});
};

interface Screen {
  name: string;
  at: string;
  pattern: string;
  draw: () => ReactNode;
  ready: string;
  /** What the screen must not say, each with why: the defect the change removed. */
  never: [RegExp, string][];
}

const SCREENS: Screen[] = [
  {
    name: "req66",
    at: "/projects/forge/requirements/REQ-66",
    pattern: "/projects/$slug/requirements/$requirement",
    draw: () => <RequirementScreen projectId={P} slug="forge" reqKey="REQ-66" />,
    ready: "[data-testid=checklist]",
    never: [
      [/\d+ open/, "an accept by decision reads its checklist as open beside Nothing owed"],
      [/feedback\.declined/, "the untraced workflow's raw event names stand on the first screen"],
    ],
  },
  {
    name: "req12",
    at: "/projects/forge/requirements/REQ-12",
    pattern: "/projects/$slug/requirements/$requirement",
    draw: () => <RequirementScreen projectId={P} slug="forge" reqKey="REQ-12" />,
    ready: "[data-testid=checklist]",
    never: [[/module-boundaries\.mjs/, "a criterion's row reads its code anchor"]],
  },
  {
    name: "channel",
    at: `/projects/forge/channels/${COMMUNICATE.rid}`,
    pattern: "/projects/$slug/channels/$channel",
    draw: () => <ChannelScreen projectId={P} slug="forge" rid={COMMUNICATE.rid} />,
    ready: "[data-testid=channel-agent]",
    never: [[/\bNone\b/, "an empty record reads None"]],
  },
];

const at: { show: (i: number) => void } = { show: () => {} };

function Shell() {
  const [i, setI] = useState(0);
  useEffect(() => {
    at.show = setI;
  });
  const s = SCREENS[i] ?? SCREENS[0];
  return (
    <InRouter key={s.name} at={s.at} pattern={s.pattern}>
      <TopBarSlotProvider>
        <div className="min-h-screen bg-app text-fg" data-witness="page">
          <ShellTopBar chatOpen={false} onToggleChat={() => {}} />
          {s.draw()}
        </div>
      </TopBarSlotProvider>
    </InRouter>
  );
}

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
  ready: () => Boolean(q("[data-witness=page]")),
  stages: SCREENS.flatMap((s, i) =>
    (["light", "dark"] as const).map((t) => ({
      name: `${s.name}-${t}`,
      run: async () => {
        at.show(i);
        theme(t);
        window.scrollTo(0, 0);
        for (let n = 0; n < 40 && !q(s.ready); n++) await pause(100);
        await pause(800);
        if (!q(s.ready)) return [`the ${s.name} page never drew ${s.ready}`];
        const wrong: string[] = [];
        const root = document.documentElement;
        if (root.scrollWidth > root.clientWidth) wrong.push(`the page scrolls sideways: ${root.scrollWidth} px wide in a ${root.clientWidth} px window`);
        const { count, words } = firstScreenWords(q("[data-witness=page]") as HTMLElement);
        console.log(`WORDS ${s.name} ${t} ${window.innerWidth} ${count} :: ${words.join(" ")}`);
        const said = words.join(" ");
        for (const [re, why] of s.never) if (re.test(said)) wrong.push(`${why}: "${said.match(re)?.[0]}"`);
        return wrong;
      },
    })),
  ),
};

const root = document.getElementById("root");
if (!root) throw new Error("the witness page has no #root to mount into");
createRoot(root).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } })}>
    <Shell />
  </QueryClientProvider>,
);
