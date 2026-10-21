// The Questions page witnessed as drawn at phone and desktop width, light and dark: the question
// waiting on the reader, the questions raised, each owed one naming who owes it whole inside the
// window, and the form that raises one. jsdom lays nothing out, so a line cut off at 390 px goes red
// here. The raised rows carry the bodies a live project held (dev.251: a merge claim, a run's
// landing note and a requirement digest, each hundreds of words, and 566 answered and closed rows,
// almost all release records in markdown with a "Thanks." reply), cut by the same short form core
// cuts them by, so a row that grows past a few lines, or shows a `**` or `##`, goes red too. Only the
// owed rows are listed at first; answered and closed are counts, opened 20 at a time.
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
        { id: "keep", label: "Keep the old order", act: "question.answer", path: "/api/questions/q1/answer", body: { round: 1, optionId: "keep" }, needsReason: false, declines: false, effect: "Sends this answer to the run that asked.", recommended: true },
        { id: "new", label: "Use the new order", act: "question.answer", path: "/api/questions/q1/answer", body: { round: 1, optionId: "new" }, needsReason: false, declines: false, effect: null, recommended: false },
      ],
      touchedAt: AT,
      stuck: false,
      dueAt: null,
      id: "question:q1",
      topic: "question",
      proposal: null,
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

const MIN = 60_000;
const ago = (minutes: number) => new Date(Date.now() - minutes * MIN).toISOString();
const MINH = { id: "u2", name: "Minh Tran", agency: "human" as const };
type Row = RaisedQuestionsResponse["questions"][number];
const issue = (n: number, title: string) => ({ scope: "issue" as const, id: `i${n}`, key: `ISS-${n}`, title });
/** A release record as an operator posted it, in markdown, asked as a question by habit. */
const RELEASE = (n: number) =>
  n % 2 === 0
    ? `**Release 0.4.0-dev.${n}** landed on \`beta\`? Notes in [the release page](https://forge.example/r/${n}).\n\n${filler}`
    : `## Release 0.4.0-dev.${n}\n\n- shipped to beta\n- ${filler}`;

const OWED: Row[] = [
  { id: "q1", target: { scope: "requirement", id: "r7", key: "REQ-7", title: "Bulk export of patient referrals to the regional registry" }, summary: short(LONG_QUESTION), author: ANA, askedAt: AT, state: "owed", answer: null, owedBy: "members", withheld: false },
  { id: "q2", target: issue(9, "Nightly sync"), summary: short("Is the sync nightly or hourly?"), author: ANA, askedAt: AT, state: "owed", answer: null, owedBy: "agent", withheld: false },
];
/** Answered, newest first: release records each answered "Thanks.", and one real answer. */
const ANSWERED: Row[] = [
  { id: "q4", target: { scope: "feedback", id: "f2", key: "FB-2", title: "Search misses accents" }, summary: short("Does this affect names only?"), author: ANA, askedAt: ago(1), state: "answered", answer: { id: "a4", summary: short(`Names and addresses both; the index folds neither. ${filler}`), author: MINH, at: ago(1) }, owedBy: null, withheld: false },
  ...Array.from({ length: 11 }, (_, i): Row => ({ id: `a${i}`, target: issue(200 + i, `Release 0.4.0-dev.${251 - i}`), summary: short(RELEASE(251 - i)), author: ANA, askedAt: ago(10 + i * 60), state: "answered", answer: { id: `aa${i}`, summary: short("Thanks."), author: MINH, at: ago(9 + i * 60) }, owedBy: null, withheld: false })),
];
/** Closed, newest first: the long bodies a live project held, then 351 release records. */
const CLOSED: Row[] = [
  { id: "q5", target: issue(1, "Project config v1 is five strict documents with a JSON Schema and cross-field refusals by name"), summary: short(MERGE_CLAIM), author: ANA, askedAt: ago(2), state: "closed", answer: null, owedBy: null, withheld: false },
  { id: "q6", target: issue(2, "A project's config documents are stored in core behind one API"), summary: short(LANDING), author: ANA, askedAt: ago(3), state: "closed", answer: null, owedBy: null, withheld: false },
  { id: "q7", target: issue(3, "What an environment runs is read off its deployment record"), summary: short(DIGEST), author: ANA, askedAt: ago(4), state: "closed", answer: null, owedBy: null, withheld: false },
  ...Array.from({ length: 351 }, (_, i): Row => ({ id: `c${i}`, target: issue(300 + i, `Release 0.4.0-dev.${240 - (i % 200)}`), summary: short(RELEASE(240 - (i % 200))), author: ANA, askedAt: ago(30 + i * 90), state: "closed", answer: null, owedBy: null, withheld: false })),
];
const BY_STATE = { owed: OWED, answered: ANSWERED, closed: CLOSED };

/** Core's raised read: one state, a page of it by offset and limit, the counts over all of them. */
function raised(url: URL): RaisedQuestionsResponse {
  const state = url.searchParams.get("state") as keyof typeof BY_STATE | null;
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const limit = Number(url.searchParams.get("limit") ?? 200);
  const listed = state ? BY_STATE[state] : [...OWED, ...ANSWERED, ...CLOSED];
  return { by: "me", owed: OWED.length, answered: ANSWERED.length, closed: CLOSED.length, questions: listed.slice(offset, offset + limit) };
}

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
window.fetch = async (input: RequestInfo | URL) => {
  const url = new URL(String(input), "http://forge.test");
  if (url.pathname.endsWith("/needs-you/decisions")) return json(DECISIONS);
  if (url.pathname.endsWith("/raised-questions")) return json(raised(url));
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

/** No short form shows a markdown marker: a heading's hashes, `**`, `__`, a backtick or a link's brackets. */
function plain(): string[] {
  const wrong: string[] = [];
  for (const text of all("[data-testid=raised-question-summary], [data-testid=raised-question-answer] p:last-child")) {
    const said = text.textContent ?? "";
    if (/^#|\*\*|__|`|\]\(/.test(said)) wrong.push(`a short form shows its markdown: "${said.slice(0, 50)}"`);
  }
  return wrong;
}

const rowsIn = (state: string) => all(`[data-testid=raised-question][data-state=${state}]`);
const group = (state: string) => document.querySelector<HTMLElement>(`[data-testid=raised-group-${state}]`);

async function light(): Promise<string[]> {
  const wrong = [...drawn(), ...plain()];
  if (rowsIn("owed").length !== 2) wrong.push("the two owed questions are not drawn as owed");
  if (rowsIn("answered").length + rowsIn("closed").length > 0) wrong.push("an answered or closed question is listed before its group is opened");
  if (group("answered")?.textContent !== "12 answered") wrong.push(`the answered group reads "${group("answered")?.textContent}", not "12 answered"`);
  if (group("closed")?.textContent !== "354 closed") wrong.push(`the closed group reads "${group("closed")?.textContent}", not "354 closed"`);
  if (all("[data-testid=raised-question-owed-by]").length !== 2) wrong.push("a question not owed names somebody as owing it");
  return wrong;
}

async function opened(): Promise<string[]> {
  group("answered")?.click();
  group("closed")?.click();
  for (let i = 0; i < 40 && rowsIn("closed").length < 20; i += 1) await pause(50);
  document.querySelector<HTMLElement>("[data-testid=raised-more-closed]")?.click();
  for (let i = 0; i < 40 && rowsIn("closed").length < 40; i += 1) await pause(50);
  const wrong = [...drawn(), ...plain()];
  if (rowsIn("answered").length !== 12) wrong.push(`the answered group lists ${rowsIn("answered").length}, not its 12`);
  const closed = rowsIn("closed").map((r) => r.dataset.id);
  const newest = CLOSED.slice(0, 40).map((q) => q.id);
  if (closed.join() !== newest.join()) wrong.push(`the closed group, opened and shown more once, lists ${closed.length} rows, not the 40 newest in order`);
  if (!document.querySelector("[data-testid=raised-more-closed]")) wrong.push("no Show more is left though 314 closed rows are not shown");
  if (document.querySelector("[data-testid=raised-more-answered]")) wrong.push("the answered group offers Show more with nothing left to show");
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
  const wrong = [...drawn(), ...plain()];
  const line = all("[data-testid=raised-question-owed-by]")[0];
  if (line && getComputedStyle(line).color === getComputedStyle(document.body).backgroundColor) wrong.push("who owes a question is drawn in the page's own background colour");
  return wrong;
}

window.__witness = {
  cases: [
    { name: "phone", width: 390 },
    { name: "desktop", width: 1440 },
  ],
  ready: () => all("[data-testid=raised-question]").length === 2 && Boolean(group("closed")) && all("[data-testid=needs-you-decision]").length === 1,
  stages: [
    { name: "1-light", run: light },
    { name: "2-opened", run: opened },
    { name: "3-asking", run: asking },
    { name: "4-dark", run: dark },
  ],
};
