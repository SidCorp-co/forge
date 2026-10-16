// The Questions page witnessed as drawn at phone and desktop width, light and dark: the question
// waiting on the reader, the questions raised, each owed one naming who owes it whole inside the
// window, and the form that raises one. jsdom lays nothing out, so a line cut off at 390 px goes red
// here. The raised rows carry the bodies a live project held (dev.251: a merge claim, a run's
// landing note and a requirement digest, each hundreds of words), cut by the same short form core
// cuts them by, so a row that grows past a few lines goes red too.
//
//   pnpm --filter web-v2 witness witness/question-desk.witness.tsx --out <dir>

import { RAISED_QUESTION_SUMMARY_MAX, type RaisedQuestionsResponse } from "@forge/contracts/comments";
import { shortForm } from "@forge/contracts/title-text";
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

const short = (body: string) => shortForm(body, RAISED_QUESTION_SUMMARY_MAX);
const filler = Array.from({ length: 300 }, (_, i) => `clause${i}`).join(" ");
const MERGE_CLAIM = `mark_merged target=dev commit=b2b572519ae1c4f79298d0094b9583b7acfa7a67 — Landed directly on the dev branch of github.com/SidCorp-co/forge; see the commits named in the description.\nthis mark is a CLAIM Forge did not observe, not a merge it witnessed: commit b2b572519ae1c4f79298d0094b9583b7acfa7a67 is recorded here as this call's claim and is NOT in \`merged_commit_sha\`. ${filler}`;
const LANDING = `Landed on \`dev\` at 940ea1103 after the gate went green on every job the change selected, with the integration suite, the whole-tree job and the image build all passing on the merge commit and the release notes written ${filler}\n\n## What changed\n\n${filler}`;
const DIGEST = `## Requirement REQ-12 — what it asks and what is built\n\n${filler}`;
const LONG_QUESTION = `Which file formats does the registry accept today, does it need the header row, and does the nightly import read the old column order for the reports the clinics already file every week ${filler}?`;

const RAISED: RaisedQuestionsResponse = {
  by: "me",
  owed: 2,
  answered: 1,
  closed: 4,
  questions: [
    { id: "q1", target: { scope: "requirement", id: "r7", key: "REQ-7", title: "Bulk export of patient referrals to the regional registry" }, summary: short(LONG_QUESTION), author: ANA, askedAt: AT, state: "owed", answer: null, owedBy: "members", withheld: false },
    { id: "q2", target: { scope: "issue", id: "i9", key: "ISS-9", title: "Nightly sync" }, summary: short("Is the sync nightly or hourly?"), author: ANA, askedAt: AT, state: "owed", answer: null, owedBy: "agent", withheld: false },
    { id: "q4", target: { scope: "feedback", id: "f2", key: "FB-2", title: "Search misses accents" }, summary: short("Does this affect names only?"), author: ANA, askedAt: AT, state: "answered", answer: { id: "a4", summary: short(`Names and addresses both; the index folds neither. ${filler}`), author: { id: "u2", name: "Minh Tran", agency: "human" }, at: AT }, owedBy: null, withheld: false },
    { id: "q3", target: { scope: "issue", id: "i4", key: "ISS-4", title: "Old importer" }, summary: short("Can we drop the old importer?"), author: ANA, askedAt: AT, state: "closed", answer: null, owedBy: null, withheld: false },
    { id: "q5", target: { scope: "issue", id: "i1", key: "ISS-1", title: "Project config v1 is five strict documents with a JSON Schema and cross-field refusals by name" }, summary: short(MERGE_CLAIM), author: ANA, askedAt: AT, state: "closed", answer: null, owedBy: null, withheld: false },
    { id: "q6", target: { scope: "issue", id: "i2", key: "ISS-2", title: "A project's config documents are stored in core behind one API" }, summary: short(LANDING), author: ANA, askedAt: AT, state: "closed", answer: null, owedBy: null, withheld: false },
    { id: "q7", target: { scope: "issue", id: "i3", key: "ISS-3", title: "What an environment runs is read off its deployment record" }, summary: short(DIGEST), author: ANA, askedAt: AT, state: "closed", answer: null, owedBy: null, withheld: false },
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
  // a short form is a few lines at most, at any width: the body never reaches the page
  for (const text of all("[data-testid=raised-question-summary]")) {
    const lines = text.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(text).lineHeight);
    if (lines > 6) wrong.push(`a question's short form runs ${Math.round(lines)} lines (${text.textContent?.slice(0, 40)}…)`);
  }
  return wrong;
}

async function light(): Promise<string[]> {
  const wrong = drawn();
  if (all("[data-testid=raised-question][data-state=owed]").length !== 2) wrong.push("the two owed questions are not drawn as owed");
  if (all("[data-testid=raised-question][data-state=closed]").length !== 4) wrong.push("the four questions on ended issues are not drawn as closed");
  if (all("[data-testid=raised-question-owed-by]").length !== 2) wrong.push("a closed question names somebody as owing it");
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
  ready: () => all("[data-testid=raised-question]").length === 7 && all("[data-testid=needs-you-decision]").length === 1,
  stages: [
    { name: "1-light", run: light },
    { name: "2-asking", run: asking },
    { name: "3-dark", run: dark },
  ],
};
