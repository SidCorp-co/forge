// A workspace page at a phone's 390 px, measured on the scroller a person uses (ISS-691, REQ-65 BC-7).
// The workspace scrolls `<main>`, not the document (`@/design/templates/workspace-frame`), so a page
// wider than the phone pushes `main` sideways while `document.documentElement` still reads 390 / 390:
// a probe on the document passes a page a person has to scroll sideways. Here the live bar, a
// requirement's overview and the decisions a person owes are mounted in the workspace's own column and
// `main`, each with the longest words it meets in the field (an issue title on the live bar, a criterion
// line, a decision's answer), and the probe reads `main.scrollWidth` against `main.clientWidth`.
//
//   pnpm --filter web-v2 witness witness/phone-width.witness.tsx --out <dir>

import type { NeedsYouDecisions } from "@forge/contracts/needs-you-decisions";
import { needsYouDecisionsSchema } from "@forge/contracts/needs-you-decisions";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { TopBarSlotProvider } from "@/design";
import { WORKSPACE_MAIN, WORKSPACE_PAGE_COLUMN } from "@/design/templates/workspace-frame";
import { LiveBar } from "@/features/agents/components/live-bar";
import { DecisionList } from "@/features/needs-you/components/decision-list";
import { RequirementScreen } from "@/features/requirements/components/requirement-screen";
import type { RequirementDetail } from "@/features/requirements/types";
import { reqDetail } from "@/test/vi-chrome-requirements";
import "./entry";
import { InRouter } from "./router";

const P = "7f1c1d1e-0000-4000-8000-000000000692";
const AT = "2026-11-03T08:00:00.000Z";
const LONG =
  "A member's reply to the bot in a bound room thread is read for a correction, and the agent's lessons learn from what the room said";

const D: RequirementDetail = JSON.parse(
  JSON.stringify({ ...reqDetail, key: "REQ-67", title: "Delivery stalls are counted by cause on every release page" })
    .replaceAll("Tieu chi mot", LONG)
    .replaceAll("Tieu chi hai moi", `${LONG}, again`)
    .replaceAll("Tieu chi hai", `${LONG}, twice`),
) as RequirementDetail;

const master = {
  generatedAt: AT,
  projectId: P,
  state: "in_pass",
  sessionId: "m1",
  name: "master",
  device: { id: "d1", name: "box-a" },
  since: AT,
  pass: { issueKey: "ISS-867" },
  passIssueTitle: `Lessons learn from room replies: ${LONG}`,
  lastPass: null,
  slots: null,
  runsOut: 0,
  lastBeatAt: AT,
  silentAfterSeconds: 600,
  waitingOn: null,
  dialogsAnswered: null,
  outdated: null,
};

const DECISIONS: NeedsYouDecisions = needsYouDecisionsSchema.parse({
  generatedAt: AT,
  total: 1,
  decisions: [
    {
      group: "answer",
      area: "issues",
      entity: "issue",
      key: "ISS-1",
      title: "Export",
      opens: { kind: "issue", key: "ISS-1" },
      question: "Keep the old export format or move to the new one?",
      changes: "What happens next on it",
      impact: "It waits on this until it is decided.",
      recommended: { answerId: "move", why: "Whoever asked recommends it.", by: "asker" },
      noRecommendation: null,
      answers: [
        { id: "move", label: LONG.slice(0, 120), act: "question.answer", path: "/api/questions/q/answer", body: { round: 1, optionId: "move" }, needsReason: false, declines: false, effect: null, recommended: true },
        { id: "keep", label: "Keep the old format", act: "question.answer", path: "/api/questions/q/answer", body: { round: 1, optionId: "keep" }, needsReason: false, declines: false, effect: null, recommended: false },
      ],
      touchedAt: AT,
      stuck: false,
      dueAt: null,
      id: "d1",
      topic: "question",
      proposal: null,
    },
  ],
  notDecisions: [],
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
window.fetch = async (input: RequestInfo | URL) => {
  const url = new URL(String(input), "http://witness.test");
  const path = url.pathname.replace(/^\/api/, "");
  if (path === "/projects") return json([{ id: P, slug: "hop", name: "Hop", role: "viewer", orgId: null }]);
  if (path === `/projects/${P}/runs/standing` && url.searchParams.get("scope") === "live") return json({ items: [], master });
  if (path === `/projects/${P}/runs/standing`) return json({ items: [], master: { ...master, state: "idle", pass: null, passIssueTitle: null } });
  if (path === `/projects/${P}/support/turns`) return json({ generatedAt: AT, projectId: P, rooms: [] });
  if (path === `/projects/${P}/workflows`) return json({ workflows: [], returned: 0 });
  // a read no fixture answers stays in flight, drawing its loading state
  return new Promise<Response>(() => {});
};

const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
client.setQueryData(["requirement", P, D.key], D);

const q = (sel: string) => document.querySelector<HTMLElement>(sel);

window.__witness = {
  cases: [{ name: "phone-390", width: 390 }],
  ready: () => Boolean(q("[data-testid=view-overview]") && q("[data-testid=live-bar-item]") && q("[data-testid=needs-you-decision-answer]")),
  probe: () => {
    const wrong: string[] = [];
    const main = q("main");
    if (!main) return ["the page is not mounted in the workspace's main"];
    // the scroller a person uses: the document stays at the window's width while main scrolls sideways
    if (main.scrollWidth > main.clientWidth) {
      const wide = [...main.querySelectorAll<HTMLElement>("*")]
        .filter((el) => el.getBoundingClientRect().right > main.getBoundingClientRect().right + 1 && el.children.length === 0)
        .slice(0, 5)
        .map((el) => `${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : ""} ${Math.round(el.getBoundingClientRect().width)} px`);
      wrong.push(`main scrolls sideways: ${main.scrollWidth} px in ${main.clientWidth}; widest: ${wide.join(", ")}`);
    }
    if (document.documentElement.scrollWidth > window.innerWidth)
      wrong.push(`the document scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`);
    return wrong;
  },
};

const root = document.getElementById("root");
if (!root) throw new Error("the witness page has no #root to mount into");
createRoot(root).render(
  <InRouter at={`/projects/hop/requirements/${D.key}`} pattern="/projects/$slug/requirements/$requirement">
    <QueryClientProvider client={client}>
      <TopBarSlotProvider>
        <div className="flex h-screen bg-app text-fg" data-witness="page">
          <div className={WORKSPACE_PAGE_COLUMN}>
            <main className={WORKSPACE_MAIN}>
              <LiveBar projectId={P} slug="hop" />
              <DecisionList read={DECISIONS} slug="hop" />
              <RequirementScreen projectId={P} slug="hop" reqKey={D.key} />
            </main>
          </div>
        </div>
      </TopBarSlotProvider>
    </QueryClientProvider>
  </InRouter>,
);
