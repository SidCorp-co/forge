// A resolved feedback item past its verify window, witnessed at phone and desktop width: nothing
// verified it by itself (the owner's ruling of 2026-10-14), so its facts say what the record reads and
// that it waits on a triager, its verify bar says a triager answers from the record, and no line says
// Forge verifies it. Its acts are what core's read answers for a resolved item (core
// `feedback/read.ts:canOf`): the confirm block, never the triage form beside it. Every question about the
// item reads on the item itself, open and answered, since there is no Questions page (REQ-33 BC-8).
//
//   pnpm --filter web-v2 witness witness/feedback-loop-check.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { FeedbackPage } from "@/features/feedback/components/feedback-detail";
import type { FeedbackView } from "@/features/feedback/types";
import { say, waitingOn } from "@/test/said";
import "./entry";
import { InRouter } from "./router";

const P = "22222222-2222-4222-8222-222222222222";
const ANN = "66666666-6666-4666-8666-666666666666";
const AT = "2026-10-09T10:00:00.000Z";
const GONE =
  "the record reads it gone: REQ-3 BC-2 passes on the running build, and nothing was filed against it since 2026-10-01.";
// canOf for a resolved item, read by a triager who is not its reporter: no triage, the loop close's acts
const CAN = { triage: false, drop: false, verify: true, reopen: true, askVerify: true, redact: false, retarget: false, accept: false, snooze: false, message: true, tellShipped: false, note: true, attach: true };

const item = {
  id: "f53",
  key: "FB-53",
  title: "Filter resets after a reload",
  writtenLang: "en",
  kind: "bug",
  severity: "medium",
  status: "triaged",
  phase: "resolved",
  attentionGroup: "needs_you",
  waitingOn: waitingOn("you", {
    who: say("standing.who.you"),
    act: say("standing.act.sayIfGone"),
    rule: say("feedback.rule.verifyHeld", { why: GONE }),
  }),
  target: { type: "screen", key: "The board", title: null },
  // resolved reads off a carrier that shipped: an issue route, its issue closed by a release
  route: { route: "issue", carriers: [{ key: "ISS-58", status: "closed", release: "0.4.0-dev.238" }], answer: null },
  reporter: { id: ANN, name: "Ann", agency: "human" },
  dueAt: null,
  snoozed: null,
  redacted: false,
  redactedAt: null,
  createdAt: AT,
  updatedAt: AT,
  verified: null,
  recordCheck: null,
  verifyHeld: { at: "2026-10-14T08:00:00.000Z", why: GONE },
  shipNotice: null,
  body: "The board loses its filter whenever I reload the page.",
  whereSeen: null,
  duplicateOf: null,
  duplicates: [],
  source: null,
  decisions: [],
  attachments: [],
  reporters: [{ id: ANN, name: "Ann", agency: "human", from: null }],
  messages: [],
  clarification: { id: "q1", status: "answered", prompt: "Which filter reset after the reload?", answer: "Status: open" },
  questions: [
    { id: "q2", kind: "steward", status: "open", prompt: "FB-41 reads the same reload reset. Merge FB-53 into FB-41, or keep both?", answer: null, askedAt: "2026-10-12T09:00:00.000Z", answeredAt: null },
    { id: "q1", kind: "clarification", status: "answered", prompt: "Which filter reset after the reload?", answer: "Status: open", askedAt: "2026-10-09T11:00:00.000Z", answeredAt: "2026-10-09T12:00:00.000Z" },
  ],
  openSuggestions: 0,
  can: CAN,
} as unknown as FeedbackView;

window.fetch = async () => new Promise<Response>(() => {});

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
client.setQueryData(["feedback-item", P, item.key], { feedback: item });
createRoot(document.getElementById("root") as HTMLElement).render(
  <InRouter at="/projects/hop/feedback/FB-53" pattern="/projects/$slug/feedback/$feedback">
    <QueryClientProvider client={client}>
      <FeedbackPage projectId={P} slug="hop" fbKey={item.key} tab="overview" onTab={() => {}} />
    </QueryClientProvider>
  </InRouter>,
);

const q = (sel: string) => document.querySelector<HTMLElement>(sel);

function reads(): string[] {
  const wrong: string[] = [];
  const held = q("[data-testid=facts-verify-held]")?.textContent ?? "";
  if (!held.includes("Waiting on a triager: the record reads it gone")) wrong.push(`the facts read "${held}"`);
  const copy = q("[data-testid=verify-copy]")?.textContent ?? "";
  if (!copy.includes("a triager answers from what the record reads")) wrong.push(`the verify bar reads "${copy}"`);
  if ((document.body.textContent ?? "").includes("Your triage")) wrong.push("a resolved item shows the triage form");
  if (/verifies it\.|confirms a fix itself|Verified automatically/.test(document.body.textContent ?? ""))
    wrong.push("a line says Forge verifies it by itself");
  if (document.documentElement.scrollWidth > window.innerWidth)
    wrong.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px in a ${window.innerWidth} px window`);
  return wrong;
}

/** The item's questions, scrolled into view: both drawn whole, the open one first, the answer under the answered one. */
function questions(theme: "light" | "dark"): string[] {
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle("dark", theme === "dark");
  const section = q("[data-testid=feedback-questions]");
  if (!section) return ["the item draws no questions of its own"];
  section.scrollIntoView({ block: "start" });
  const wrong: string[] = [];
  const rows = [...section.querySelectorAll<HTMLElement>("[data-testid=feedback-question]")];
  if (rows.map((r) => r.dataset.status).join(",") !== "open,answered") wrong.push(`the questions read ${rows.map((r) => r.dataset.status).join(",") || "nothing"}, not open then answered`);
  if (!rows[1]?.textContent?.includes("Answer: Status: open")) wrong.push("the answered question does not say what came back");
  for (const r of rows) if (r.scrollWidth > r.clientWidth + 0.5) wrong.push(`a question row runs ${r.scrollWidth - r.clientWidth} px past its width`);
  if (document.documentElement.scrollWidth > window.innerWidth) wrong.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px in a ${window.innerWidth} px window`);
  return wrong;
}

window.__witness = {
  cases: [
    { name: "phone", width: 390 },
    { name: "desktop", width: 1440 },
  ],
  ready: () => Boolean(q("[data-testid=facts-verify-held]") && q("[data-testid=verify-copy]")),
  stages: [
    { name: "reads", run: reads },
    { name: "questions-light", run: () => questions("light") },
    { name: "questions-dark", run: () => questions("dark") },
  ],
};
