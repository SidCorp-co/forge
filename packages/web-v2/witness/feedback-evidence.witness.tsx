// A feedback item's page witnessed at phone and desktop width (REQ-35 BC-8, BC-12; ISS-462): it opens
// on its screenshot and its recordings, above what the reporter said and the actions, with the step
// it hits lit on that workflow's canvas; every screenshot and recording is read by a text alternative,
// never its file name; and the attached recording plays in the page. jsdom lays nothing out and plays
// nothing, so this is where "opens on" and "plays" go red.
//
// The files the item holds are read from `<out>` beside the page, since Chrome reaches no network
// here: put `IMG_0042.png` and `spinner.webm` there before the run.
//
//   pnpm --filter web-v2 witness witness/feedback-evidence.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { createRoot } from "react-dom/client";
import { FeedbackPage } from "@/features/feedback/components/feedback-detail";
import type { FeedbackView } from "@/features/feedback/types";
import { RULE, say, waitingOn } from "@/test/said";
import "./entry";

const P = "22222222-2222-4222-8222-222222222222";
const ANN = "66666666-6666-4666-8666-666666666666";
const AT = "2026-10-09T10:00:00.000Z";
/** Where the page sits on disk: the item's files are read from beside it. */
const here = window.location.pathname.replace(/\/[^/]*$/, "");
const NONE = { triage: true, drop: false, verify: false, reopen: false, askVerify: false, redact: false, retarget: true, accept: true, snooze: true, message: true, tellShipped: false, note: true, attach: true };

const file = (id: string, name: string, mime: string, at: string) => ({
  id,
  from: null,
  name,
  mime,
  size: 30_000,
  flagged: false,
  uploadedBy: ANN,
  uploadedByName: "Ann",
  createdAt: at,
  url: `${here}/${name}`,
});

const item = {
  id: "f52",
  key: "FB-52",
  title: "Save order spins forever",
  writtenLang: "en",
  kind: "bug",
  severity: "high",
  status: "new",
  phase: "new",
  attentionGroup: "needs_you",
  waitingOn: waitingOn("you", { who: say("standing.who.you"), act: say("standing.act.triageIt"), rule: RULE }),
  target: { type: "workflow", key: "checkout", title: "Checkout", node: { step: "pay" } },
  route: null,
  reporter: { id: ANN, name: "Ann", agency: "human" },
  dueAt: null,
  snoozed: null,
  redacted: false,
  redactedAt: null,
  createdAt: AT,
  updatedAt: AT,
  verified: null,
  autoVerify: null,
  verifyHeld: null,
  shipNotice: null,
  body: "I pressed Save on a new order. The button spins and nothing is saved; the console says the save failed with a 500.",
  whereSeen: null,
  duplicateOf: null,
  duplicates: [],
  source: null,
  decisions: [],
  attachments: [file("a1", "IMG_0042.png", "image/png", AT), file("v1", "spinner.webm", "video/webm", "2026-10-09T10:05:00.000Z")],
  reporters: [{ id: ANN, name: "Ann", agency: "human", from: null }],
  messages: [],
  clarification: null,
  openSuggestions: 0,
  can: NONE,
} as unknown as FeedbackView;

const recording = {
  id: "99999999-9999-4999-8999-999999999999",
  projectId: P,
  feedbackId: "88888888-8888-4888-8888-888888888888",
  previewId: "77777777-7777-4777-8777-777777777777",
  build: { sha: "c".repeat(40), release: "1.4.0" },
  state: "stopped",
  reason: null,
  recordedBy: "55555555-5555-4555-8555-555555555555",
  startedAt: "2026-10-09T09:30:00.000Z",
  stoppedAt: "2026-10-09T09:33:00.000Z",
  expiresAt: "2026-11-08T09:33:00.000Z",
  events: 42,
  bytes: 2048,
  timeline: [
    { at: 0, kind: "navigate", text: "Opened https://shop.test/orders/new" },
    { at: 3400, kind: "click", text: "Clicked Save order" },
    { at: 3520, kind: "request_failed", text: "POST https://shop.test/api/orders answered 500" },
  ],
};

const step = (id: string, title: string, after: string[]) => ({ id, title, does: "", after });
const workflow = {
  revision: 3,
  writer: "u1",
  writerName: "Lan",
  design: { status: "approved", approvedRevision: 3 },
  document: { id: "w1", flow: "checkout", title: "Checkout", summary: "", kind: "flow", version: 1, steps: [step("cart", "Cart", []), step("pay", "Pay", ["cart"]), step("done", "Done", ["pay"])], edges: [] },
};

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
window.fetch = async (input: RequestInfo | URL) => {
  const path = new URL(String(input), "http://forge.test").pathname;
  if (path.endsWith("/feedback/FB-52/recordings")) return json({ recordings: [recording] });
  if (path.endsWith(`/projects/${P}/workflows`)) return json({ workflows: [workflow], returned: 1 });
  if (path.endsWith("/workflow-templates")) return json({ templates: [] });
  return new Promise<Response>(() => {});
};

const router = { push() {}, replace() {}, prefetch() {}, back() {}, forward() {}, refresh() {}, hmrRefresh() {} };
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
client.setQueryData(["feedback-item", P, item.key], { feedback: item });
createRoot(document.getElementById("root") as HTMLElement).render(
  // the page keeps its view in the URL, so it is mounted under a router as the app mounts it
  <AppRouterContext.Provider value={router as never}>
    <PathnameContext.Provider value={`/projects/hop/feedback/${item.key}`}>
      <SearchParamsContext.Provider value={new URLSearchParams() as never}>
        <QueryClientProvider client={client}>
          <FeedbackPage projectId={P} slug="hop" fbKey={item.key} tab="overview" onTab={() => {}} />
        </QueryClientProvider>
      </SearchParamsContext.Provider>
    </PathnameContext.Provider>
  </AppRouterContext.Provider>,
);

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const top = (el: Element | null) => (el ? el.getBoundingClientRect().top : Number.POSITIVE_INFINITY);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

function opens(): string[] {
  const wrong: string[] = [];
  const evidence = q("[data-testid=feedback-evidence]");
  const shot = q<HTMLImageElement>("[data-testid=feedback-screenshots] img");
  if (!evidence || !shot) return ["the page draws no evidence section with a screenshot"];
  if (top(evidence) >= window.innerHeight) wrong.push(`the evidence starts at ${Math.round(top(evidence))} px, below the first screen of ${window.innerHeight} px`);
  if (top(evidence) >= top(q("[data-testid=feedback-body]"))) wrong.push("the screenshot is not above what the reporter said");
  if (top(evidence) >= top(q("#feedback-act"))) wrong.push("the screenshot is not above the actions");
  if (shot.naturalWidth === 0) wrong.push("the screenshot did not load");
  if (shot.alt !== "Screenshot 1 of 1 for FB-52: Save order spins forever") wrong.push(`the screenshot is read as "${shot.alt}"`);
  if ([...document.querySelectorAll("img")].some((i) => i.alt.includes("IMG_0042"))) wrong.push("an image is read by its file name");
  const rows = [...document.querySelectorAll("[data-testid=recording-row]")].map((r) => r.getAttribute("data-kind"));
  if (rows.join(",") !== "upload,reproduce") wrong.push(`the recordings read ${rows.join(",") || "nothing"}, not the upload then the reproduce`);
  const video = q<HTMLVideoElement>("[data-testid=recording-video]");
  if (video?.getAttribute("aria-label") !== "Recording 1 of 2 for FB-52: Save order spins forever") wrong.push(`the recording is read as "${video?.getAttribute("aria-label")}"`);
  const figure = q("[data-testid=feedback-step]");
  if (figure?.getAttribute("aria-label") !== "Checkout workflow with Pay highlighted") wrong.push(`the step figure is read as "${figure?.getAttribute("aria-label")}"`);
  const traced = [...document.querySelectorAll(".wfc-card[data-traced=true]")].map((c) => c.textContent ?? "");
  if (traced.length !== 1 || !traced[0]?.includes("Pay")) wrong.push(`the canvas lights ${traced.length} steps (${traced.join(" | ")}), not Pay alone`);
  if (document.documentElement.scrollWidth > window.innerWidth) wrong.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px in a ${window.innerWidth} px window`);
  return wrong;
}

async function plays(): Promise<string[]> {
  const video = q<HTMLVideoElement>("[data-testid=recording-video]");
  if (!video) return ["no recording player on the page"];
  video.muted = true;
  await video.play().catch(() => undefined);
  await pause(1200);
  const wrong: string[] = [];
  if (video.error) wrong.push(`the recording failed to load: code ${video.error.code}`);
  if (!(video.currentTime > 0)) wrong.push(`the recording did not play: it stands at ${video.currentTime} s, readyState ${video.readyState}`);
  video.pause();
  return wrong;
}

window.__witness = {
  cases: [
    { name: "phone", width: 390 },
    { name: "desktop", width: 1440 },
  ],
  ready: () => {
    const shot = q<HTMLImageElement>("[data-testid=feedback-screenshots] img");
    return Boolean(shot?.complete && q(".wfc-card[data-traced=true]") && document.querySelectorAll("[data-testid=recording-row]").length === 2);
  },
  stages: [
    { name: "opens", run: opens },
    { name: "plays", run: plays },
  ],
};
