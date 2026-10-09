// A requirement's and a feedback item's checklists witnessed at phone and desktop width (REQ-34 r2
// BC-5, BC-26; ISS-457 criteria 1 and 3): each answer reads as a property under its question, each
// gap as the question still to answer with its act beside it, an assumed answer stays marked as one,
// and its correction by a later revision reads beside it. jsdom lays nothing out, so a question and
// its answer crushed into one line at 390 px, or a row wider than the window, go red only here.
//
//   pnpm --filter web-v2 witness witness/item-checklists.witness.tsx --out <dir>

import {
  FEEDBACK_TRIAGE_CHECKLIST,
  REQUIREMENT_ACCEPTANCE_CHECKLIST,
  REQUIREMENT_READY_CHECKLIST,
} from "@forge/contracts/checklist-registry";
import type { ChecklistRead } from "@forge/contracts/checklist-read";
import { type Checklist, checklistFormOf, evaluateChecklist, type RecordAnswers } from "@forge/contracts/checklists";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { FeedbackChecklists, RequirementChecklists } from "@/features/checklists/components/item-checklists";
import "./entry";

const P = "22222222-2222-4222-8222-222222222222";
const AT = "2026-10-09T10:00:00.000Z";

function record(checklist: Checklist, values: Record<string, string>): RecordAnswers {
  return Object.fromEntries(
    checklist.questions
      .filter((q) => q.answeredBy.by === "record")
      .map((q) => [q.id, values[q.id] !== undefined ? { value: values[q.id] as string } : { gap: "It states none yet.", fix: "Write it on a new revision." }]),
  );
}

const readOf = (checklist: Checklist, now: RecordAnswers | null, moves: ChecklistRead["moves"] = []): ChecklistRead => ({
  id: checklist.id,
  version: checklist.version,
  gates: checklist.gates,
  design: checklist.design,
  form: checklistFormOf(checklist),
  input: {},
  now: now ? evaluateChecklist(checklist, { given: {}, record: now }) : null,
  moves,
});

const READY = {
  problem: "Referral clerks lose the patient filter every time the board reloads.",
  value: "A clerk finds the patient at once.",
  measured: "Searches per referral fall by half.",
  who: "Referral clerk, clinic owner",
  criteria: "2 criteria: BC-1, BC-2",
  questions: "None open.",
  workflows: "referral-intake revision 3",
};
const atAgree = evaluateChecklist(REQUIREMENT_READY_CHECKLIST, { given: {}, record: record(REQUIREMENT_READY_CHECKLIST, READY) });
const requirement = {
  requirementId: "r1",
  key: "REQ-7",
  revision: 2,
  checklists: [
    readOf(REQUIREMENT_READY_CHECKLIST, record(REQUIREMENT_READY_CHECKLIST, { ...READY, kind: "rule" }), [
      { at: AT, from: "draft", to: "agreed", gate: "requirement_ready", standing: "passed", checklist: { id: "requirement_ready", version: 1 }, answers: [...atAgree.answers], refusals: null, actor: { type: "user", agency: "human", id: "u1" }, source: "requirements", countsAsPassed: true },
    ]),
    readOf(REQUIREMENT_ACCEPTANCE_CHECKLIST, record(REQUIREMENT_ACCEPTANCE_CHECKLIST, { verdicts: "Every current criterion passes on the running build.", evidence: "Each counted verdict cites its evidence." })),
  ],
};
const feedback = {
  feedbackId: "f52",
  key: "FB-52",
  checklists: [readOf(FEEDBACK_TRIAGE_CHECKLIST, record(FEEDBACK_TRIAGE_CHECKLIST, { kind: "bug", requirement: "REQ-7" }))],
};

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
window.fetch = async (input: RequestInfo | URL) => {
  const path = new URL(String(input), "http://forge.test").pathname;
  if (path.endsWith("/requirements/REQ-7/checklist")) return json(requirement);
  if (path.endsWith("/feedback/FB-52/checklist")) return json(feedback);
  return new Promise<Response>(() => {});
};

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById("root") as HTMLElement).render(
  <QueryClientProvider client={client}>
    <main className="grid max-w-[900px] gap-10 px-8 py-6 max-md:px-4">
      <RequirementChecklists projectId={P} reqKey="REQ-7" onRevise={() => {}} />
      <FeedbackChecklists projectId={P} fbKey="FB-52" canTriage />
    </main>
  </QueryClientProvider>,
);

const rows = () => [...document.querySelectorAll<HTMLElement>("[data-testid=checklist-row]")];
const box = (el: Element | null) => el?.getBoundingClientRect() ?? null;

function probe(): string[] {
  const wrong: string[] = [];
  const sections = [...document.querySelectorAll<HTMLElement>("[data-testid=checklist]")].map((s) => s.dataset.checklist);
  if (sections.join(",") !== "requirement_ready,requirement_acceptance,feedback_triage") wrong.push(`the checklists read ${sections.join(",") || "nothing"}`);
  const phone = window.innerWidth < 768;
  for (const row of rows()) {
    const q = box(row.querySelector("dt"));
    const a = box(row.querySelector("dd"));
    const r = box(row);
    if (!q || !a || !r) continue;
    if (r.right > window.innerWidth + 0.5) wrong.push(`the ${row.dataset.question} row runs past the window: ${Math.round(r.right)} px of ${window.innerWidth}`);
    if (q.width < 120) wrong.push(`the ${row.dataset.question} question is ${Math.round(q.width)} px wide`);
    if (phone && a.top < q.bottom - 1) wrong.push(`at ${window.innerWidth} px the ${row.dataset.question} answer sits beside its question, not under it`);
    if (!phone && Math.abs(a.top - q.top) > 4) wrong.push(`at ${window.innerWidth} px the ${row.dataset.question} answer is not beside its question`);
  }
  const kind = rows().find((r) => r.dataset.question === "kind" && r.closest("[data-checklist=requirement_ready]"));
  if (kind?.dataset.state !== "corrected") wrong.push(`the assumed kind reads ${kind?.dataset.state ?? "nothing"}, not corrected`);
  if (!kind?.textContent?.includes("Assumed") || !kind.textContent.includes("Now, from r2")) wrong.push("the kind row does not show both the assumption and its correction");
  const gap = rows().find((r) => r.dataset.question === "severity");
  const act = box(gap?.querySelector("a") ?? null);
  if (!act || act.width === 0) wrong.push("the severity gap has no visible Answer beside it");
  if (document.documentElement.scrollWidth > window.innerWidth) wrong.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px in a ${window.innerWidth} px window`);
  return wrong;
}

window.__witness = {
  cases: [
    { name: "phone", width: 390 },
    { name: "desktop", width: 1440 },
  ],
  ready: () => document.querySelectorAll("[data-testid=checklist]").length === 3,
  probe,
};
