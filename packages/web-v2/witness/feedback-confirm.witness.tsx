// A feedback item's page witnessed at phone and desktop width, in light and dark (REQ-66 BC-4, BC-8;
// ISS-695): an open clarification reads the answer the asker recommends beside its question, and a
// shipped fix reported by an agent reads that its own read asked it, and the evidence it confirms
// from: the violated criterion's verdict on the running build and a link to its clip.
//
//   pnpm --filter web-v2 witness witness/feedback-confirm.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { FeedbackPage } from "@/features/feedback/components/feedback-detail";
import type { FeedbackView } from "@/features/feedback/types";
import { none, progress, work } from "@/test/feedback-progress";
import { RULE, say, sentence, waitingOn } from "@/test/said";
import "./entry";
import { InRouter } from "./router";

const P = "22222222-2222-4222-8222-222222222222";
const ANN = "66666666-6666-4666-8666-666666666666";
const BOT = "77777777-7777-4777-8777-777777777777";
const AT = "2026-10-20T10:00:00.000Z";
const CAN = { triage: false, drop: false, verify: false, reopen: false, askVerify: false, redact: false, retarget: false, snooze: false, message: false, tellShipped: false, note: false, attach: false, clarify: false };

const base = {
  writtenLang: "en",
  kind: "bug",
  severity: "medium",
  target: { type: "screen", key: "The board", title: null, node: null },
  dueAt: null,
  snoozed: null,
  redacted: false,
  redactedAt: null,
  createdAt: AT,
  updatedAt: AT,
  verified: null,
  recordCheck: null,
  verifyHeld: null,
  whereSeen: null,
  duplicateOf: null,
  duplicates: [],
  origin: null,
  decisions: [],
  attachments: [],
  messages: [],
  questions: [],
  openSuggestions: 0,
  reporterNotTold: null,
  sensitive: false,
  can: CAN,
};

const asked = {
  ...base,
  id: "f61",
  key: "FB-61",
  title: "The board scrolls by itself",
  status: "new",
  phase: "new",
  attentionGroup: "waiting",
  waitingOn: waitingOn("person", { who: say("standing.who.named", { name: "Ann" }), act: say("standing.act.triageIt"), rule: RULE }),
  route: null,
  reporter: { id: ANN, name: "Ann", agency: "human" },
  reporters: [{ id: ANN, name: "Ann", agency: "human", from: null }],
  body: "The board scrolls to the top by itself every few seconds.",
  shipNotice: null,
  shipEvidence: null,
  clarification: { id: "q1", status: "open", prompt: "Which browser shows it?", recommended: "Chrome 130 on macOS", answer: null },
} as unknown as FeedbackView;

const told = say("feedback.told.agentAsked");
const evidence = say("feedback.evidence.passes", { ref: "REQ-3 BC-2" });
const shipped = {
  ...base,
  id: "f62",
  key: "FB-62",
  title: "forge claim refuses a free lease",
  status: "triaged",
  phase: "resolved",
  attentionGroup: "moving",
  waitingOn: waitingOn("agent", { who: say("standing.who.named", { name: "catalog-fe" }), act: say("standing.act.verifyFixIn", { v: "0.4.0-dev.309" }), rule: say("feedback.rule.agentConfirms") }),
  route: { route: "issue", carriers: [{ key: "ISS-654", title: "Free leases are claimable", status: "closed", release: "0.4.0-dev.309" }] },
  reporter: { id: BOT, name: "catalog-fe", agency: "agent" },
  reporters: [{ id: BOT, name: "catalog-fe", agency: "agent", from: null }],
  body: "forge claim --next refuses a lease nobody holds.",
  shipNotice: { state: "told", how: "asked", at: AT, release: "0.4.0-dev.309", by: null, shipped: { at: AT, release: "0.4.0-dev.309" }, told: sentence(told), says: { told } },
  shipEvidence: {
    criterion: "REQ-3 BC-2",
    verdict: "passing",
    why: null,
    clip: { name: "bc2.webm", mime: "video/webm", url: "/api/attachments/a1/download" },
    reads: sentence(evidence),
    says: { reads: evidence },
  },
  clarification: null,
} as unknown as FeedbackView;

// every read the page makes is answered, so no section stands on a loading placeholder in the shots
const PROGRESS = {
  "FB-61": progress("FB-61", work(), none("untriaged")),
  "FB-62": progress("FB-62", work({ state: "shipped", total: 1, issues: [{ key: "ISS-654", title: "Free leases are claimable", status: "closed" }] }), {
    kind: "shipped",
    version: "0.4.0-dev.309",
    at: AT,
  }),
} as const;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
window.fetch = async (input: RequestInfo | URL) => {
  const path = new URL(String(input), "http://forge.test").pathname;
  const fb = /\/forecast\/feedback\/(FB-\d+)$/.exec(path)?.[1];
  if (fb && fb in PROGRESS) return json(PROGRESS[fb as keyof typeof PROGRESS]);
  if (/\/feedback\/FB-\d+\/similar$/.test(path)) return json({ status: "ok", hits: [{ key: "FB-40", title: "Claim refuses a lease after a restart", phase: "resolved", similarity: 0.71 }] });
  return new Promise<Response>(() => {});
};
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const root = createRoot(document.getElementById("root") as HTMLElement);
function show(item: FeedbackView) {
  client.setQueryData(["feedback-item", P, item.key], { feedback: item });
  root.render(
    <InRouter at={`/projects/hop/feedback/${item.key}`} pattern="/projects/$slug/feedback/$feedback">
      <QueryClientProvider client={client}>
        <FeedbackPage projectId={P} slug="hop" fbKey={item.key} tab="overview" onTab={() => {}} />
      </QueryClientProvider>
    </InRouter>,
  );
}
show(asked);

const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const settle = () => new Promise((r) => setTimeout(r, 300));
const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};
/** Below 1024px the rail stands behind one Facts row: open it so the shot shows the facts. */
const openFacts = async () => {
  const toggle = q("[data-testid=rail-facts-toggle]");
  if (toggle && toggle.getAttribute("aria-expanded") !== "true") toggle.click();
  await settle();
};
/** A loading placeholder left standing is a section the shot does not show. */
const placeholders = () =>
  [...document.querySelectorAll<HTMLElement>("[data-testid=feedback-progress], [data-testid=feedback-similar]")]
    .filter((s) => s.querySelector(".skeleton") || /checking for similar/i.test(s.textContent ?? ""))
    .map((s) => `${s.dataset.testid} is still loading`);
const sideways = () =>
  document.documentElement.scrollWidth > window.innerWidth ? [`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`] : [];

function recommended(): string[] {
  const wrong = [...sideways(), ...placeholders()];
  const line = q("[data-testid=feedback-clarification-recommended]");
  if (!line?.textContent?.includes("Recommended: Chrome 130 on macOS")) wrong.push(`the open question reads its recommendation as "${line?.textContent ?? "nothing"}"`);
  if (line && line.scrollWidth > line.clientWidth + 0.5) wrong.push("the recommendation is cut");
  const badge = q("[data-testid=feedback-clarification] > *");
  const box = q("[data-testid=feedback-clarification]");
  if (badge && box && badge.getBoundingClientRect().width >= box.getBoundingClientRect().width - 1) wrong.push("the question's status badge stretches across the row");
  return wrong;
}

function confirmFrom(): string[] {
  const wrong = [...sideways(), ...placeholders()];
  const asked = q("[data-testid=facts-ship-notice]")?.textContent ?? "";
  if (!/^Asked to confirm\d+\w+ ago$/.test(asked)) wrong.push(`the asked row reads "${asked}"`);
  const ev = q("[data-testid=ship-evidence]")?.textContent ?? "";
  if (!ev.includes("REQ-3 BC-2 passes on the running build.")) wrong.push(`the evidence reads "${ev}"`);
  const clip = q("[data-testid=ship-evidence-clip]");
  if (clip?.getAttribute("href") !== "/api/attachments/a1/download") wrong.push("the clip is not linked");
  return wrong;
}

window.__witness = {
  cases: [
    { name: "phone", width: 390 },
    { name: "desktop", width: 1440 },
  ],
  ready: () => Boolean(q("[data-testid=feedback-clarification-recommended]")),
  stages: [
    { name: "1-asked-light", run: async () => (theme("light"), await openFacts(), recommended()) },
    { name: "2-asked-dark", run: async () => (theme("dark"), await settle(), recommended()) },
    {
      name: "3-confirm-light",
      run: async () => {
        theme("light");
        show(shipped);
        await settle();
        await openFacts();
        return confirmFrom();
      },
    },
    { name: "4-confirm-dark", run: async () => (theme("dark"), await settle(), confirmFrom()) },
  ],
};
