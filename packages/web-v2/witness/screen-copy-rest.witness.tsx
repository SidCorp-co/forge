// The screens ISS-1184 changes, drawn from forge-dev's own reads of 2026-11-09 (trimmed into
// screen-copy-rest.fixture.json) at 1440 by 900 and 390 by 844, light then dark:
// - home: the live bar names ISS-1184's build, and Moving no longer lists it again under the bar;
// - bell: a stuck-work notice reads in plain words, never "Pipeline wedge: claim hop miss on session";
// - req90: a requirement waiting to re-tie its issues names them and the criterion by title, never by key;
// - req12: Mark delivered, held, names the criteria not passing in its tooltip, never their codes;
// - req66: the value check's questions fold to their name and state;
// - channels: each room's row names its agent and whether it is live;
// - channel: #Forge-Communicate's name on the first view at 390, and Common issues offers Add;
// - workflows: a design linked to no requirement reads "Unlinked", never "None".
// `VITE_WITNESS_BEFORE=1` draws what core said before (keys in the wait, the old notice, no agent on a
// channel's row), for the before counts on origin/dev's web. Each stage prints `WORDS <screen> <theme>
// <width> <n> whole <m>` (witness/first-screen.ts) and fails where the screen says what the change removed.
//
//   [VITE_WITNESS_BEFORE=1] pnpm --filter web-v2 witness witness/screen-copy-rest.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { NotificationsMenu, TopBarSlotProvider } from "@/design";
import { LiveBar } from "@/features/agents";
import { ChannelScreen, ChannelsScreen } from "@/features/channels";
import { toNotificationItem } from "@/features/notifications/map";
import type { NotificationRow } from "@/features/notifications/types";
import { RequirementScreen } from "@/features/requirements/components/requirement-screen";
import { ShellTopBar } from "@/features/shell/components/shell-top-bar";
import { WorkflowsScreen } from "@/features/workflows/components/workflows-screen";
import { Route as HomeRoute } from "@/routes/_workspace/projects/$slug/index";
import { firstScreenWords } from "./first-screen";
import "./entry";
import { InRouter } from "./router";
import ONCE from "./screens-once.fixture.json";
import FIXTURE from "./screen-copy-rest.fixture.json";

const BEFORE = import.meta.env.VITE_WITNESS_BEFORE === "1";
const P = "d1bb4907-74d9-4228-85ff-76121523af7d";
const AT = "2026-11-09T14:20:00.000Z";
const RID = FIXTURE.channel.rid;

// ── REQ-90 waiting to re-tie ISS-1112 and ISS-1110 to BC-13's current wording (the UI review's row) ──
const ISSUES = {
  "ISS-1112": "Working agreements C: agents receive the effective agreements for their task, and each run records which revisions it got",
  "ISS-1110": "Working agreements A: one authoritative agreement record per project, resolved against defaults, grants and locked guarantees, that a brief and a grant cannot contradict",
};
// core's words for the act, before (keys) and now (`standing-proof.ts`: the criterion by its short
// title, each issue by its title's lead, `lib/named-items.ts:issueName`)
const retie = BEFORE
  ? { key: "standing.act.retie", vars: { keys: Object.keys(ISSUES).join(", "), codes: "BC-13" } }
  : { key: "standing.act.retie", vars: { issues: "“Working agreements C” and “Working agreements A”", criteria: "“When the feature ships”" } };
const REQ90 = {
  ...FIXTURE.req90,
  status: "in_delivery",
  standing: {
    ...FIXTURE.req90.standing,
    state: "in_delivery",
    attentionGroup: "waiting",
    waitingOn: {
      kind: "agent",
      who: "Master",
      act: BEFORE ? "tie ISS-1112, ISS-1110 to the current wording of BC-13, then judge it" : "tie the two issues to the current wording, then judge it",
      rule: "BC-13 not judged",
      ref: null,
      dueAt: null,
      says: { who: { key: "standing.who.master" }, act: retie, rule: { key: "requirements.rule.unjudged", vars: { codes: "BC-13" } } },
    },
  },
};

// ── the bell: two stuck-work notices queue-hop.ts and the zombie reaper write ──
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

// ── core stubbed over fetch: each read the screens send, answered from the fixture ──
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const quietMaster = FIXTURE.runsLive.master;
const channelRow = { rid: RID, name: FIXTURE.channel.name, members: 0, rules: 0, commonIssues: 0, ...(BEFORE ? {} : { agent: FIXTURE.channel.agent }) };
const READS: [string | RegExp, () => unknown][] = [
  ["/projects", () => [{ id: P, slug: "forge", name: "Forge", role: "admin", orgId: null, orgRole: null }]],
  [`/projects/${P}/requirements/REQ-90`, () => REQ90],
  [`/projects/${P}/requirements/REQ-90/checklist`, () => FIXTURE.req90Checklist],
  [`/projects/${P}/requirements/REQ-12`, () => ONCE.req12],
  [`/projects/${P}/requirements/REQ-12/checklist`, () => ONCE.req12Checklist],
  [`/projects/${P}/requirements/REQ-66`, () => ONCE.req66],
  [`/projects/${P}/requirements/REQ-66/checklist`, () => ONCE.req66Checklist],
  [`/projects/${P}/intake-drafts/REQ-66`, () => FIXTURE.intakeReq66],
  [`/projects/${P}/workflow-templates`, () => ONCE.templates],
  [`/projects/${P}/workflows`, () => FIXTURE.workflows],
  [`/projects/${P}/support/channels`, () => ({ channels: [channelRow] })],
  [`/projects/${P}/support/channels/${RID}`, () => ({ channel: { ...FIXTURE.channel, memberRows: [], ruleRows: [], commonIssueRows: [], routes: [{ route: "forge", members: [] }, { route: "technical", members: [] }, { route: "product", members: [] }] } })],
  [`/projects/${P}/support/turns`, () => ({ generatedAt: AT, projectId: P, rooms: [] })],
  [`/projects/${P}/needs-you/decisions`, () => FIXTURE.decisions],
  [`/projects/${P}/issues/standing`, () => FIXTURE.issuesStanding],
  [`/projects/${P}/releases/shipped`, () => FIXTURE.shipped],
  [`/projects/${P}/debts`, () => FIXTURE.debts],
];
window.fetch = async (input: RequestInfo | URL) => {
  const url = new URL(String(input), "http://witness.test");
  // the home leaves by the URL's slug before the project list answers (`useProjectRef`)
  const path = url.pathname.replace(/^\/api/, "").replace(/^\/projects\/forge\//, `/projects/${P}/`);
  if (path === `/projects/${P}/runs/standing`)
    return json(url.searchParams.get("scope") === "live" ? FIXTURE.runsLive : { ...FIXTURE.runsLive, items: [], leased: [], master: quietMaster });
  const hit = READS.find(([p]) => (typeof p === "string" ? p === path : p.test(path)));
  if (hit) return json(hit[1]());
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

const Home = HomeRoute.options.component as () => ReactNode;

interface Screen {
  name: string;
  at: string;
  pattern: string;
  draw: () => ReactNode;
  ready: string;
  /** What the screen must not say after the change, each with why: the defect it removed. */
  never: [RegExp, string][];
  /** What the screen must say after the change. */
  says?: [RegExp, string][];
  /** What else the page must hold after the change, one sentence per thing wrong. */
  check?: () => string[];
  /** An act the stage takes before it counts (Mark delivered focused, for its tooltip). */
  act?: () => Promise<void>;
}

const keyOf = (re: RegExp, why: string): [RegExp, string] => [re, why];

const SCREENS: Screen[] = [
  {
    name: "home",
    at: "/projects/forge",
    pattern: "/projects/$slug",
    draw: () => (
      <>
        <LiveBar projectId={P} slug="forge" />
        <Home />
      </>
    ),
    ready: "[data-testid=live-bar]",
    never: [],
    check: () => {
      const n = (q("[data-witness=page]")?.innerText.match(/Screen copy that core writes/g) ?? []).length;
      return n === 1 ? [] : [`ISS-1184's title shows ${n} times: on the live bar and again in Moving`];
    },
  },
  {
    name: "bell",
    at: "/projects/forge",
    pattern: "/projects/$slug",
    draw: () => (
      <div className="mx-auto max-w-[420px] p-4" data-testid="bell-witness">
        <NotificationsMenu items={NOTICES.map((r) => toNotificationItem(r, undefined, "en"))} onMarkAllRead={() => {}} />
      </div>
    ),
    ready: "[data-testid=bell-witness]",
    never: [keyOf(/Pipeline wedge|hop miss|WHERE:|WHY:|WHAT:/, "a stuck-work notice reads the detector's labels")],
  },
  {
    name: "req90",
    at: "/projects/forge/requirements/REQ-90",
    pattern: "/projects/$slug/requirements/$requirement",
    draw: () => <RequirementScreen projectId={P} slug="forge" reqKey="REQ-90" />,
    ready: "[data-testid=checklist]",
    never: [keyOf(/ISS-11\d\d|\bBC-13\b/, "the wait names its issues and criterion by key")],
  },
  {
    name: "req12",
    at: "/projects/forge/requirements/REQ-12",
    pattern: "/projects/$slug/requirements/$requirement",
    draw: () => <RequirementScreen projectId={P} slug="forge" reqKey="REQ-12" />,
    ready: "[data-testid=checklist]",
    never: [keyOf(/\bBC-\d+\b/, "Mark delivered's tooltip names criteria by code")],
    act: async () => {
      const held = [...document.querySelectorAll<HTMLElement>("button")].find((b) => b.innerText.trim() === "Mark delivered");
      const trigger = held?.parentElement;
      if (!trigger) return;
      const box = trigger.getBoundingClientRect();
      const at = { bubbles: true, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2, pointerType: "mouse" };
      for (const type of ["pointerenter", "pointerover", "pointermove"]) trigger.dispatchEvent(new PointerEvent(type, at));
      for (const type of ["mouseenter", "mouseover", "mousemove"]) trigger.dispatchEvent(new MouseEvent(type, at));
      await pause(900);
    },
  },
  {
    name: "req66",
    at: "/projects/forge/requirements/REQ-66",
    pattern: "/projects/$slug/requirements/$requirement",
    draw: () => <RequirementScreen projectId={P} slug="forge" reqKey="REQ-66" />,
    ready: "[data-testid=checklist]",
    never: [],
  },
  {
    name: "channels",
    at: "/projects/forge/channels",
    pattern: "/projects/$slug/channels",
    draw: () => <ChannelsScreen projectId={P} slug="forge" />,
    ready: "[data-testid=channel-row], [data-testid=list-row]",
    never: [],
    says: [[/Live|Not live/, "each room's row says whether its agent is live"]],
  },
  {
    name: "channel",
    at: `/projects/forge/channels/${RID}`,
    pattern: "/projects/$slug/channels/$channel",
    draw: () => <ChannelScreen projectId={P} slug="forge" rid={RID} />,
    ready: "section[aria-label=Members]",
    never: [keyOf(/\bNone\b/, "an empty record reads None")],
    says: [[/Forge-Communicate/, "the room's name is on the first view"]],
  },
  {
    name: "workflows",
    at: "/projects/forge/workflows",
    pattern: "/projects/$slug/workflows",
    draw: () => <WorkflowsScreen projectId={P} slug="forge" projectName="Forge" />,
    ready: "[data-testid=workflow-row]",
    never: [],
    check: () => {
      const cells = [...document.querySelectorAll<HTMLElement>("[data-testid=workflow-requirements]")].map((e) => e.innerText.trim());
      const none = cells.filter((c) => c === "None" || c === "");
      return cells.length === 0 ? ["no design row names its requirements"] : none.length ? [`${none.length} design rows read "${none[0]}" for no linked requirement`] : [];
    },
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
        for (let n = 0; n < 50 && !q(s.ready); n++) await pause(100);
        await pause(900);
        if (!q(s.ready)) return [`the ${s.name} page never drew ${s.ready}`];
        await s.act?.();
        const wrong: string[] = [];
        const root = document.documentElement;
        if (root.scrollWidth > root.clientWidth) wrong.push(`the page scrolls sideways: ${root.scrollWidth} px wide in a ${root.clientWidth} px window`);
        const page = q("[data-witness=page]") as HTMLElement;
        const { count, words } = firstScreenWords(page);
        const whole = firstScreenWords(page, { whole: true });
        // a tooltip is drawn in a portal outside the page and the root: its words are read with the page's
        const tip = !s.act ? "" : [...document.body.children].filter((e): e is HTMLElement => e instanceof HTMLElement && e.id !== "root" && e.tagName !== "SCRIPT").map((e) => e.innerText.trim()).filter(Boolean).join(" ");
        console.log(`WORDS ${s.name} ${t} ${window.innerWidth} ${count} whole ${whole.count} :: ${words.join(" ")}${tip ? ` || TIP ${tip}` : ""}`);
        if (BEFORE) return [];
        const said = `${whole.words.join(" ")} ${tip}`;
        for (const [re, why] of s.never) if (re.test(said)) wrong.push(`${why}: "${said.match(re)?.[0]}"`);
        const first = `${words.join(" ")} ${tip}`;
        for (const [re, why] of s.says ?? []) if (!re.test(first)) wrong.push(`${why}: not said`);
        wrong.push(...(s.check?.() ?? []));
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
