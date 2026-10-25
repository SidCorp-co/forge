// A feedback item's page witnessed at phone and desktop width, in light and dark (REQ-66 BC-3; ISS-694):
// the reports that joined it after its filing read under what the reporter said, each with who said it
// again, when, from where, in their own words, and a link to the screenshot they took.
//
// Chrome reaches no network here, so the screenshot is read from `<out>` beside the page: put any
// image there as `screenshot.jpg` before the run.
//
//   pnpm --filter web-v2 witness witness/feedback-occurrences.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { FeedbackPage } from "@/features/feedback/components/feedback-detail";
import type { FeedbackView } from "@/features/feedback/types";
import { none, progress, work } from "@/test/feedback-progress";
import { RULE, say, waitingOn } from "@/test/said";
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
  occurrences: [],
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

/** Where the page sits on disk: the item's screenshot is read from beside it. */
const here = window.location.pathname.replace(/\/[^/]*$/, "");
const SHOT = `${here}/screenshot.jpg`;
const item = {
  ...base,
  id: "f41",
  key: "FB-41",
  title: "The ward board scrolls to the top by itself",
  status: "new",
  phase: "new",
  attentionGroup: "waiting",
  waitingOn: waitingOn("person", { who: say("standing.who.named", { name: "Ann" }), act: say("standing.act.triageIt"), rule: RULE }),
  route: null,
  reporter: { id: ANN, name: "Ann", agency: "human" },
  reporters: [
    { id: ANN, name: "Ann", agency: "human", from: null },
    { id: BOT, name: "Minh", agency: "human", from: null },
  ],
  body: null,
  shipNotice: null,
  shipEvidence: null,
  clarification: null,
  attachments: [
    { id: "a2", redacted: true, from: null, name: "screenshot.jpg", mime: "image/jpeg", size: 48211, flagged: true, uploadedBy: BOT, uploadedByName: "Minh", createdAt: AT, url: SHOT },
  ],
  occurrences: [
    { id: "o1", reporter: { id: BOT, name: "Minh", agency: "human" }, said: "The board jumps back to the top while I read bed 9", attachmentId: "a2", from: null, at: AT },
    { id: "o2", reporter: { id: "88888888-8888-4888-8888-888888888888", name: "catalog-fe", agency: "agent" }, said: null, attachmentId: null, from: { slug: "catalog", name: "Catalog" }, at: AT },
  ],
} as unknown as FeedbackView;

// every read the page makes is answered, so no section stands on a loading placeholder in the shots
const PROGRESS = { "FB-41": progress("FB-41", work(), none("untriaged")) } as const;
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
show(item);

const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const settle = () => new Promise((r) => setTimeout(r, 300));
const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};
const sideways = () =>
  document.documentElement.scrollWidth > window.innerWidth ? [`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`] : [];

function occurrences(): string[] {
  const wrong = sideways();
  const rows = document.querySelectorAll("[data-testid=feedback-occurrence]");
  if (rows.length !== 2) wrong.push(`the page lists ${rows.length} reports that joined it, not 2`);
  const heading = q("[data-testid=feedback-occurrences] h3")?.textContent ?? "";
  if (!heading.includes("Also reported")) wrong.push(`the section is headed "${heading}"`);
  if (!rows[0]?.textContent?.includes("The board jumps back to the top while I read bed 9")) wrong.push("a repeat's own words are not shown");
  if (q("[data-testid=feedback-occurrence-shot]")?.getAttribute("href") !== SHOT) wrong.push("the repeat's screenshot is not linked");
  if (q("[data-testid=attached-image-failed]")) wrong.push("the screenshot did not load: put an image at <out>/screenshot.jpg");
  if (!rows[1]?.textContent?.includes("from Catalog")) wrong.push("a repeat from another project does not say where from");
  return wrong;
}

window.__witness = {
  cases: [
    { name: "phone", width: 390 },
    { name: "desktop", width: 1440 },
  ],
  ready: () => Boolean(q("[data-testid=feedback-occurrences]")),
  stages: [
    { name: "1-light", run: async () => (theme("light"), await settle(), occurrences()) },
    { name: "2-dark", run: async () => (theme("dark"), await settle(), occurrences()) },
  ],
};
