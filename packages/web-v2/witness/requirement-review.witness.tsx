// A requirement's page as its reviewer meets it (ISS-1109, FB-567), in three standings at 1440 and 390,
// light then dark: a first revision proposed with nothing built yet, an agreed revision in delivery
// with its workflow, and an agreed screen with no picture drawn. Each first view says the title, the
// state, whose turn and one act; the rest opens on demand. Probes fail where the page:
//   - reads a proposal nobody has built as failed proof: a verdict mark on each criterion, "0/n verified";
//   - says "Not stated" for each goal label a goal written as prose leaves out, instead of the prose;
//   - gives a missing picture a tall empty box at the top of the page;
//   - draws more than one primary act in its header, or more words than its first-view budget.
// Each stage prints `WORDS <case> <theme> <width> <n>` and is shot to `<out>/<width>-<case>-<theme>.png`.
//
//   pnpm --filter web-v2 witness witness/requirement-review.witness.tsx --out <dir>

import { say } from "@forge/contracts/said";
import { waitingOn } from "@forge/contracts/standing";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { TopBarSlotProvider } from "@/design";
import { RequirementScreen } from "@/features/requirements/components/requirement-screen";
import type { RequirementDetail } from "@/features/requirements/types";
import { ShellTopBar } from "@/features/shell/components/shell-top-bar";
import { reqDetail } from "@/test/vi-chrome-requirements";
import { firstScreenWords } from "./first-screen";
import "./entry";
import { InRouter } from "./router";
import { BUDGETS } from "./screens.budgets";

const MOST_WORDS = BUDGETS["requirement-detail"].budget;
const P = "7f1c1d1e-0000-4000-8000-000000001109";
const AT = "2026-11-07T08:00:00.000Z";
const RULE = say("standing.empty");
const STEPS = ["Cart", "Address", "Pay", "Confirm", "Ship"];

const WORKFLOW = {
  workflowId: "w-checkout",
  revision: 3,
  writer: "u1",
  writerName: "Lan",
  requirements: [],
  design: { status: "approved", approvedRevision: 3 },
  document: {
    version: 2,
    project: P,
    flow: "checkout",
    kind: "flow",
    title: "Checkout",
    summary: "",
    template: { id: "operational-flow", version: 1 },
    steps: STEPS.map((title, i) => ({ id: title.toLowerCase(), title, does: title, after: i ? [STEPS[i - 1]?.toLowerCase()] : [], node: { type: "TASK", label: title } })),
    writtenBy: {},
    id: "w-checkout",
    createdAt: AT,
    updatedAt: AT,
  },
};

const base = reqDetail.revisions.find((r) => r.state === "current") as RequirementDetail["revisions"][number];
// compact titles, as FB-567 asks a criterion's line to read; the wording behind each opens on demand
const CRITERIA = [
  "Members see inherited agreements",
  "Members see project overrides",
  "Agents get the effective agreements",
  "Each run records its agreements",
  "A change names who and why",
];
const criterion = (body: string, i: number) => ({ id: `BC-${i + 1}`, code: `BC-${i + 1}`, body, form: "statement" as const, sinceRevision: 1, retiredRevision: null });
const gap = (body: string, i: number) => ({ code: `BC-${i + 1}`, body, verdict: "gap", verdicts: [], issues: [], uncoveredReason: null });

const facts = { ...reqDetail.standing.facts, passing: 0, judged: 0, criteria: CRITERIA.length, issuesRunning: 0, issuesTotal: 0, proposedRevision: 1, draftRevision: null };

/** REQ-90's shape: one revision, proposed, its goal written as prose, nothing built. */
const PROPOSED: RequirementDetail = {
  ...reqDetail,
  key: "REQ-90",
  title: "Working agreements a project inherits, overrides and gives its agents",
  status: "draft",
  currentRevision: null,
  revisions: [
    {
      ...base,
      revision: 1,
      state: "proposed",
      baseRevision: null,
      proposedAt: AT,
      decidedAt: null,
      kind: null,
      picture: null,
      writtenLang: "en",
      tldr: null,
      changeSummary: "First revision: agreements as one record a project inherits and overrides.",
      reason: "Owner request FB-569",
      spec: {
        goal: "Projects follow the same working agreements without restating them, see where they differ, and agents run under the ones in force.",
        personas: ["Project owner"],
        scopeIn: [],
        scopeOut: [],
        assumptions: [],
      },
      criteria: CRITERIA.map(criterion),
    } as unknown as RequirementDetail["revisions"][number],
  ],
  criteria: CRITERIA.map(criterion),
  workflows: [],
  traces: [],
  baselines: [],
  issues: [],
  releases: [],
  feedback: [],
  bindings: [],
  questions: [],
  unclear: 0,
  standing: {
    ...reqDetail.standing,
    state: "draft",
    next: "agreed",
    attentionGroup: "needs_you",
    waitingOn: waitingOn("you", { who: say("standing.who.you"), act: say("standing.act.acceptR", { r: 1 }), rule: RULE }),
    facts,
    shownRevision: 1,
    coverage: CRITERIA.map(gap),
    delivery: { phase: "draft", liveIssues: 0, startedIssues: 0, closedIssues: 0, criteriaCoverage: { criteria: CRITERIA.length, passing: 0, judged: 0 } },
  },
} as unknown as RequirementDetail;

const current = { ...base, kind: "process", picture: null, writtenLang: "en", tldr: null, spec: { ...base.spec, goal: "Problem: buyers leave when checkout asks for the card twice.\nValue: a buyer pays in one step.\nMeasured by: checkouts finished per day." } };

/** An agreed revision in delivery, its workflow its picture. */
const AGREED: RequirementDetail = {
  ...reqDetail,
  key: "REQ-65",
  title: "Checkout takes a card",
  revisions: [current as RequirementDetail["revisions"][number]],
  workflows: [{ workflowId: "w-checkout", flow: "checkout", title: "Checkout", designStatus: "approved", approvedRevision: 3 }],
  traces: [
    { code: "BC-1", workflowId: "w-checkout", flow: "checkout", steps: ["pay"], edges: [{ from: "address", to: "pay" }] },
    { code: "BC-2", workflowId: "w-checkout", flow: "checkout", steps: ["confirm"], edges: [] },
  ],
  standing: { ...reqDetail.standing, waitingOn: waitingOn("agent", { who: say("standing.who.master"), act: say("standing.act.none"), rule: RULE }), attentionGroup: "moving", facts: { ...reqDetail.standing.facts, proposedRevision: null } },
} as unknown as RequirementDetail;

/** An agreed screen whose wireframe nobody has drawn. */
const NO_PICTURE: RequirementDetail = {
  ...AGREED,
  key: "REQ-70",
  title: "The clinic's front desk books a patient in one screen",
  revisions: [{ ...current, kind: "screen", picture: null } as RequirementDetail["revisions"][number]],
  workflows: [],
  traces: [],
} as unknown as RequirementDetail;

const CASES = [
  ["proposed", PROPOSED],
  ["agreed", AGREED],
  ["no-picture", NO_PICTURE],
] as const;

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
window.fetch = async (input: RequestInfo | URL) => {
  const path = new URL(String(input), "http://witness.test").pathname.replace(/^\/api/, "");
  if (path === "/projects") return json([{ id: P, slug: "hop", name: "Hop", role: "admin", orgId: null }]);
  if (path === `/projects/${P}/workflows`) return json({ workflows: [WORKFLOW], returned: 1 });
  if (path === `/projects/${P}/workflow-templates`) return json({ templates: [] });
  // a read no fixture answers stays in flight, drawing its loading state
  return new Promise<Response>(() => {});
};

const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
for (const [, d] of CASES) client.setQueryData(["requirement", P, d.key], d);

const at: { show: (i: number) => void } = { show: () => {} };

function Page() {
  const [i, setI] = useState(0);
  useEffect(() => {
    at.show = setI;
  });
  const d = CASES[i]?.[1] ?? PROPOSED;
  return (
    <InRouter key={d.key} at={`/projects/hop/requirements/${d.key}`} pattern="/projects/$slug/requirements/$requirement">
      <TopBarSlotProvider>
        <div className="min-h-screen bg-app text-fg" data-witness="page">
          <ShellTopBar chatOpen={false} onToggleChat={() => {}} />
          <RequirementScreen projectId={P} slug="hop" reqKey={d.key} />
        </div>
      </TopBarSlotProvider>
    </InRouter>
  );
}

const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const all = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};

function wrongOf(name: string): string[] {
  const out: string[] = [];
  if (document.documentElement.scrollWidth > window.innerWidth) out.push(`${name}: the page scrolls sideways (${document.documentElement.scrollWidth} px in ${window.innerWidth})`);
  const primaries = all("[data-testid=requirement-screen] :is(a,button).bg-accent").filter((b) => b.offsetParent !== null);
  if (primaries.length > 1) out.push(`${name}: the header draws ${primaries.length} primary acts`);
  if (name === "proposed") {
    const dots = all("[data-testid=criteria-checklist] [data-testid=verdict-dot]");
    if (dots.length > 0) out.push(`proposed: nothing is built, yet ${dots.length} criteria carry a verdict mark (${dots.map((d) => d.dataset.verdict).join(", ")})`);
    const verified = q("[data-testid=progress-verified]");
    if (verified) out.push(`proposed: nothing is built, yet the strip says "${verified.innerText.trim()}"`);
    const notStated = all("[data-testid=requirement-goal]").flatMap((g) => g.innerText.match(/Not stated/g) ?? []);
    if (notStated.length > 1) out.push(`proposed: the goal says "Not stated" ${notStated.length} times instead of its prose`);
    if (!q("[data-testid=requirement-goal]")?.innerText.includes("Projects follow the same working agreements")) out.push("proposed: the goal's prose is not on the page");
  }
  if (name === "no-picture") {
    const empty = q("[data-testid=picture-empty]");
    const section = q("[data-testid=requirement-picture]");
    // one line wide; on a phone its two acts may take a second
    const most = window.innerWidth < 768 ? 100 : 72;
    if (section && section.getBoundingClientRect().height > most) out.push(`no-picture: an absent picture takes ${Math.round(section.getBoundingClientRect().height)} px at the top of the page`);
    if (!empty) out.push("no-picture: an absent picture is not said at all");
  }
  // every criterion stays reachable: one opens to its wording
  const line = q("[data-testid=criterion-line]");
  if (!line) out.push(`${name}: no criterion to open`);
  return out;
}

window.__witness = {
  cases: [
    { name: "1440", width: 1440 },
    { name: "390", width: 390 },
  ],
  ready: () => Boolean(q("[data-testid=view-overview]")),
  stages: CASES.flatMap(([name], i) =>
    (["light", "dark"] as const).map((t) => ({
      name: `${name}-${t}`,
      run: async () => {
        at.show(i);
        theme(t);
        window.scrollTo(0, 0);
        await pause(1200);
        const threw = q("[data-witness=threw]");
        if (threw) return [`${name}: the page threw`];
        const { count, words } = firstScreenWords(q("[data-witness=page]") as HTMLElement);
        console.log(`WORDS ${name} ${t} ${window.innerWidth} ${count} :: ${words.join(" ")}`);
        const wrong = wrongOf(name);
        if (count > MOST_WORDS) wrong.push(`${name}: ${count} words on the first screen, over ${MOST_WORDS}`);
        return wrong;
      },
    })),
  ),
};

const root = document.getElementById("root");
if (!root) throw new Error("the witness page has no #root to mount into");
createRoot(root).render(
  <QueryClientProvider client={client}>
    <Page />
  </QueryClientProvider>,
);
