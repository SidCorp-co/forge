// The Questions page witnessed as drawn at phone and desktop width, light and dark: the question
// waiting on the reader, the questions raised, each owed one naming who owes it whole inside the
// window, and the form that raises one. jsdom lays nothing out, so a line cut off at 390 px goes red
// here.
//
//   pnpm --filter web-v2 witness witness/question-desk.witness.tsx --out <dir>

import type { RaisedQuestionsResponse } from "@forge/contracts/comments";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { QuestionDesk } from "@/features/question-desk";
import "./entry";
import { InRouter } from "./router";

const AT = new Date(Date.now() - 3 * 3_600_000).toISOString();
const ANA = { id: "u1", name: "Ana Pereira", agency: "human" as const };

const DECISIONS = {
  generatedAt: AT,
  total: 1,
  decisions: [
    {
      group: "answer",
      area: "issues",
      entity: "issue",
      key: "ISS-41",
      title: "Bulk export",
      opens: { kind: "issue", key: "ISS-41" },
      question: "Should the export keep the old column order for existing reports?",
      recommended: { answerId: "keep", why: 'Whoever asked recommends "Keep the old order".', by: "asker" },
      noRecommendation: null,
      answers: [
        { id: "keep", label: "Keep the old order", act: "question.answer", path: "/api/questions/q1/answer", body: { round: 1, optionId: "keep" }, needsReason: false, effect: "Sends this answer to the run that asked.", recommended: true },
        { id: "new", label: "Use the new order", act: "question.answer", path: "/api/questions/q1/answer", body: { round: 1, optionId: "new" }, needsReason: false, effect: null, recommended: false },
      ],
      touchedAt: AT,
    },
  ],
  notDecisions: [],
};

const RAISED: RaisedQuestionsResponse = {
  by: "me",
  owed: 3,
  answered: 1,
  questions: [
    { id: "q1", target: { scope: "requirement", id: "r7", key: "REQ-7", title: "Bulk export of patient referrals to the regional registry" }, body: "Which file formats does the registry accept today, and does it need the header row?", author: ANA, askedAt: AT, answer: null, owedBy: "members", withheld: false },
    { id: "q2", target: { scope: "issue", id: "i9", key: "ISS-9", title: "Nightly sync" }, body: "Is the sync nightly or hourly?", author: ANA, askedAt: AT, answer: null, owedBy: "agent", withheld: false },
    { id: "q3", target: { scope: "issue", id: "i4", key: "ISS-4", title: "Old importer" }, body: "Can we drop the old importer?", author: ANA, askedAt: AT, answer: null, owedBy: "nobody", withheld: false },
    { id: "q4", target: { scope: "feedback", id: "f2", key: "FB-2", title: "Search misses accents" }, body: "Does this affect names only?", author: ANA, askedAt: AT, answer: { id: "a4", body: "Names and addresses both; the index folds neither.", author: { id: "u2", name: "Minh Tran", agency: "human" }, at: AT }, owedBy: null, withheld: false },
  ],
};

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
window.fetch = async (input: RequestInfo | URL) => {
  const url = new URL(String(input), "http://forge.test");
  if (url.pathname.endsWith("/needs-you/decisions")) return json(DECISIONS);
  if (url.pathname.endsWith("/raised-questions")) return json(RAISED);
  if (url.pathname.endsWith("/projects/p1/requirements")) return json({ requirements: [{ key: "REQ-7", title: "Bulk export of patient referrals" }] });
  return new Promise<Response>(() => {});
};

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById("root") as HTMLElement).render(
  <InRouter at="/projects/hop/questions">
    <QueryClientProvider client={client}>
      <QuestionDesk projectId="p1" slug="hop" />
    </QueryClientProvider>
  </InRouter>,
);

const all = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

function drawn(): string[] {
  const wrong: string[] = [];
  const width = window.innerWidth;
  if (document.documentElement.scrollWidth > width) wrong.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${width}`);
  for (const line of all("[data-testid=raised-question-owed-by]")) {
    const r = line.getBoundingClientRect();
    if (r.width === 0 || r.right > width) wrong.push(`"${line.textContent}" is cut off at ${Math.round(r.right)} px in ${width}`);
  }
  for (const row of all("[data-testid=raised-question], [data-testid=needs-you-decision]")) {
    if (row.getBoundingClientRect().right > width) wrong.push(`a question row runs past the window (${row.dataset.id ?? row.dataset.key})`);
  }
  return wrong;
}

async function light(): Promise<string[]> {
  const wrong = drawn();
  if (all("[data-testid=raised-question][data-owed=true]").length !== 3) wrong.push("the three owed questions are not drawn as owed");
  return wrong;
}

async function asking(): Promise<string[]> {
  all("[data-testid=question-desk-ask]")[0]?.click();
  for (let i = 0; i < 20 && !document.querySelector("[data-testid=question-ask-target] option[value=REQ-7]"); i += 1) await pause(50);
  const wrong = drawn();
  const form = document.querySelector<HTMLElement>("[data-testid=question-ask]");
  if (!form) return [...wrong, "the form that raises a question does not open"];
  if (form.getBoundingClientRect().right > window.innerWidth) wrong.push("the form that raises a question runs past the window");
  return wrong;
}

async function dark(): Promise<string[]> {
  document.documentElement.dataset.theme = "dark";
  await pause(150);
  const wrong = drawn();
  const line = all("[data-testid=raised-question-owed-by]")[0];
  if (line && getComputedStyle(line).color === getComputedStyle(document.body).backgroundColor) wrong.push("who owes a question is drawn in the page's own background colour");
  return wrong;
}

window.__witness = {
  cases: [
    { name: "phone", width: 390 },
    { name: "desktop", width: 1440 },
  ],
  ready: () => all("[data-testid=raised-question]").length === 4 && all("[data-testid=needs-you-decision]").length === 1,
  stages: [
    { name: "1-light", run: light },
    { name: "2-asking", run: asking },
    { name: "3-dark", run: dark },
  ],
};
