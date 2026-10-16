// A feedback item's progress, its similar items and the reporter's clarification, witnessed as drawn at
// phone and desktop width, in the light theme and the dark: every work state and every reason an item
// has no date says its line whole, inside the window, and the draft's likely duplicates and the
// clarification form fit beside them. jsdom lays nothing out, so a reason cut off at 390 px goes red
// here.
//
//   pnpm --filter web-v2 witness witness/feedback-progress.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { ClarifyReporter } from "@/features/feedback/components/feedback-clarify";
import { FeedbackProgress } from "@/features/feedback/components/feedback-progress";
import { DraftDuplicates, SimilarFeedback } from "@/features/feedback/components/feedback-similar";
import type { FeedbackView } from "@/features/feedback/types";
import { PROGRESS_CASES } from "@/test/feedback-progress";
import "./entry";
import { InRouter } from "./router";

const SIMILAR = {
  status: "ok",
  hits: [
    { key: "FB-9", title: "Export drops the header row when the sheet has merged cells", phase: "planned", similarity: 0.82 },
    { key: "FB-3", title: "Export is missing a column", phase: "new", similarity: 0.61 },
    { key: "FB-5", title: "CSV export is empty", phase: "resolved", similarity: 0.55 },
  ],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(String(input), "http://forge.test").pathname;
  const progress = /\/forecast\/feedback\/(FB-\d+)$/.exec(path);
  const item = progress ? PROGRESS_CASES.find((c) => c.key === progress[1]) : undefined;
  if (item) return json(item);
  if (path.endsWith("/feedback/FB-12/similar")) return json(SIMILAR);
  if (path.endsWith("/feedback/FB-11/similar")) return json({ status: "provider_not_configured", hits: [] });
  if (init?.method === "POST" && path.endsWith("/feedback/similar")) return json(SIMILAR);
  return new Promise<Response>(() => {});
};

const CAN = { triage: true, drop: true, verify: false, reopen: false, askVerify: false, redact: false, retarget: false, snooze: true, message: true, tellShipped: false, note: true, attach: false, clarify: true };
const ITEM = { id: "f1", key: "FB-11", phase: "new", can: CAN } as unknown as FeedbackView;

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById("root") as HTMLElement).render(
  <InRouter>
    <QueryClientProvider client={client}>
      <main className="grid gap-6 bg-bg p-4 text-fg">
        <div className="grid gap-4 lg:grid-cols-2">
          {PROGRESS_CASES.map((c) => (
            <div key={c.key} className="rounded-md border border-line-subtle p-3" data-witness="case">
              <p className="mb-2 font-mono text-12 text-muted">{c.key}</p>
              <FeedbackProgress projectId="p1" slug="hop" fbKey={c.key} />
            </div>
          ))}
        </div>
        <div className="grid gap-6 lg:grid-cols-2">
          <SimilarFeedback projectId="p1" slug="hop" fbKey="FB-12" />
          <SimilarFeedback projectId="p1" slug="hop" fbKey="FB-11" />
        </div>
        <DraftDuplicates projectId="p1" slug="hop" title="Export drops the header row" body="" />
        <ClarifyReporter projectId="p1" f={ITEM} />
      </main>
    </QueryClientProvider>
  </InRouter>,
);

const all = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Everything wrong with how the progress blocks, the similar lists and the form sit in the window. */
function drawn(): string[] {
  const wrong: string[] = [];
  const width = window.innerWidth;
  if (document.documentElement.scrollWidth > width) wrong.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${width}`);
  for (const block of all("[data-testid=feedback-progress]")) {
    const key = block.closest("[data-witness=case]")?.querySelector("p")?.textContent ?? "?";
    const estimate = block.querySelector<HTMLElement>("[data-testid=feedback-progress-estimate]");
    if (!estimate || !(estimate.textContent ?? "").trim()) wrong.push(`${key} draws no estimate and no reason`);
    const why = block.querySelector<HTMLElement>("[data-testid=feedback-progress-no-date]");
    if (why) {
      const r = why.getBoundingClientRect();
      if (r.width === 0 || r.right > width) wrong.push(`${key}'s reason "${why.textContent}" is cut off at ${Math.round(r.right)} px in ${width}`);
    }
    for (const badge of block.querySelectorAll<HTMLElement>("[data-testid=feedback-progress-work] *")) {
      if (badge.getBoundingClientRect().right > width) wrong.push(`${key}'s work state runs past the window`);
    }
  }
  for (const hit of all("[data-testid=similar-hit]")) {
    if (hit.getBoundingClientRect().right > width) wrong.push(`a similar item, ${hit.dataset.key}, runs past the window`);
  }
  for (const form of all("[data-testid=feedback-clarify]")) {
    if (form.getBoundingClientRect().right > width) wrong.push("the clarification form runs past the window");
  }
  return wrong;
}

async function light(): Promise<string[]> {
  return drawn();
}

async function asking(): Promise<string[]> {
  all("[data-testid=feedback-clarify-open]")[0]?.click();
  await pause(100);
  const wrong = drawn();
  if (!document.querySelector("[data-testid=feedback-clarify-prompt]")) wrong.push("the clarification form does not open");
  return wrong;
}

async function dark(): Promise<string[]> {
  document.documentElement.dataset.theme = "dark";
  await pause(150);
  const wrong = drawn();
  const line = all("[data-testid=feedback-progress-no-date]")[0];
  if (line && getComputedStyle(line).color === getComputedStyle(document.body).backgroundColor) wrong.push("a reason's words are the page's own background colour");
  return wrong;
}

window.__witness = {
  cases: [
    { name: "phone", width: 390 },
    { name: "desktop", width: 1440 },
  ],
  ready: () =>
    all("[data-testid=feedback-progress][data-estimate]").length === PROGRESS_CASES.length &&
    all("[data-testid=similar-hit]").length >= 3 &&
    document.querySelector("[data-testid=similar-not-compared]") !== null &&
    document.querySelector("[data-testid=feedback-draft-duplicates] [data-testid=similar-hits]") !== null,
  stages: [
    { name: "1-light", run: light },
    { name: "2-asking", run: asking },
    { name: "3-dark", run: dark },
  ],
};
