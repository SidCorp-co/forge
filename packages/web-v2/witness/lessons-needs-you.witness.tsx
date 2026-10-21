// Lessons in the one Needs you list witnessed as drawn (REQ-50 BC-2, BC-5, BC-7), on the Approvals
// page at desktop and phone width, light and dark: a confusion an agent raised, its question carrying
// both sides and its recommended answer marked; a lesson the steward proposed, to approve or reject;
// and a lesson proposed for retirement. Then the confusion's peek, whose footer decides it. The read
// is parsed by the contract's own schema, as core's fold sends it (`needs-you-lessons.ts`).
//
//   pnpm --filter web-v2 witness witness/lessons-needs-you.witness.tsx --out <dir>

import { type NeedsYouDecision, needsYouDecisionsSchema } from "@forge/contracts/needs-you-decisions";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { ApprovalsScreen } from "@/features/approvals";
import "./entry";
import { InRouter } from "./router";

const P = "6f0ee160-8432-4b84-98cf-956b6cd65a29";
const at = (hours: number) => new Date(Date.UTC(2026, 9, 21, 9) - hours * 3_600_000).toISOString();
const base = { area: "requirements", entity: "lesson", stuck: false, dueAt: null, topic: "lesson" } as const;
const decide = `/api/projects/${P}/lessons/confusions/cf1/decide`;

const CONFUSION: NeedsYouDecision = {
  ...base,
  id: "lesson-confusion:cf1",
  group: "answer",
  key: "L-4",
  title: "Conflicts with a lesson",
  opens: { kind: "lesson", key: "L-4" },
  question:
    "L-4 is held: conflicts with a lesson. The lesson says: Large type asks for 16 pt in every patient letter. Against it (L-2): The house style sets every letter in 11 pt, and the print template cannot hold two sizes.",
  recommended: { answerId: "edit", why: "Recommended by the agent that raised it.", by: "steward" },
  noRecommendation: null,
  answers: [
    { id: "keep", label: "Keep", act: "lesson.confusion", path: decide, body: { resolution: "keep" }, needsReason: false, declines: false, effect: "L-4 is applied again as it reads.", recommended: false },
    {
      id: "edit",
      label: "Edit as recommended",
      act: "lesson.confusion",
      path: decide,
      body: { resolution: "edit", sentence: "Print patient letters in 16 pt; keep the house style for every other letter." },
      needsReason: false,
      declines: false,
      effect: "L-4 is applied again, reading: Print patient letters in 16 pt; keep the house style for every other letter.",
      recommended: true,
    },
    { id: "retire", label: "Retire", act: "lesson.confusion", path: decide, body: { resolution: "retire" }, needsReason: false, declines: false, effect: "L-4 is retired; no agent applies it.", recommended: false },
  ],
  touchedAt: at(5),
  proposal: null,
};

const PROPOSED: NeedsYouDecision = {
  ...base,
  id: "lesson:l5",
  group: "approve",
  key: "L-5",
  title: "Name the ward and the bed in every handover a nurse reads.",
  opens: { kind: "lesson", key: "L-5" },
  question: "Approve lesson L-5: Name the ward and the bed in every handover a nurse reads.",
  recommended: null,
  noRecommendation: "The steward grouped these corrections; check the sentence says what they meant.",
  answers: [
    { id: "approve", label: "Approve", act: "lesson.approve", path: `/api/projects/${P}/lessons/L-5/approve`, body: {}, needsReason: false, declines: false, effect: "Every agent in its scope applies L-5 from now on", recommended: false },
    { id: "decline", label: "Reject", act: "lesson.reject", path: `/api/projects/${P}/lessons/L-5/reject`, body: {}, needsReason: true, declines: true, effect: "No agent applies it; your reason is kept on the lesson.", recommended: false },
  ],
  touchedAt: at(30),
  proposal: {
    verb: "Approve lesson",
    what: "Name the ward and the bed in every handover a nurse reads.",
    recommends: false,
    tags: [{ text: "L-5", tone: "plain" }],
    consequences: ["Every agent in its scope applies L-5 from now on"],
    why: [
      { label: "REQ-12", value: "The handover has no bed number." },
      { label: "ISS-88", value: "Which bed? The handover only says the ward." },
    ],
    said: null,
    table: null,
    yields: [{ kind: "approved", n: 1 }],
  },
};

const RETIRE: NeedsYouDecision = {
  ...base,
  id: "lesson-retire:l3",
  group: "approve",
  key: "L-3",
  title: "Greet the patient by first name in the portal.",
  opens: { kind: "lesson", key: "L-3" },
  question: "Retire lesson L-3? No agent applied it in 30 days.",
  recommended: { answerId: "approve", why: "No agent applied it in 30 days.", by: "rule" },
  noRecommendation: null,
  answers: [
    { id: "approve", label: "Retire", act: "lesson.retire", path: `/api/projects/${P}/lessons/L-3/retire`, body: { reason: "No agent applied it in 30 days." }, needsReason: false, declines: false, effect: "No agent applies it any more; the lesson and its history are kept.", recommended: true },
    { id: "keep", label: "Keep", act: "lesson.keep", path: `/api/projects/${P}/lessons/L-3/keep`, body: {}, needsReason: false, declines: false, effect: "It stays in use, and its unused clock starts again.", recommended: false },
  ],
  touchedAt: at(2),
  proposal: {
    verb: "Retire lesson",
    what: "Greet the patient by first name in the portal.",
    recommends: true,
    tags: [{ text: "L-3", tone: "plain" }],
    consequences: ["No agent applies L-3 any more"],
    why: [{ label: "REQ-9", value: "Use the first name." }],
    said: null,
    table: null,
    yields: [{ kind: "approved", n: 1 }],
  },
};

const READ = needsYouDecisionsSchema.parse({
  generatedAt: "2026-10-21T09:00:00.000Z",
  total: 3,
  decisions: [CONFUSION, PROPOSED, RETIRE],
  notDecisions: [],
});

window.localStorage.clear();
window.fetch = async (input: RequestInfo | URL) => {
  if (String(input).includes(`/projects/${P}/needs-you/decisions`)) return new Response(JSON.stringify(READ), { headers: { "content-type": "application/json" } });
  return new Promise<Response>(() => {});
};
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

createRoot(document.getElementById("root") as HTMLElement).render(
  <InRouter at="/projects/hop/approvals" pattern="/projects/$slug/approvals">
    <QueryClientProvider client={client}>
      <main className="min-h-screen bg-app">
        <ApprovalsScreen projectId={P} slug="hop" />
      </main>
    </QueryClientProvider>
  </InRouter>,
);

const rows = () => [...document.querySelectorAll<HTMLElement>("[data-testid=approval-row]")];
const settle = () => new Promise((r) => setTimeout(r, 200));
const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};
const sideways = (): string[] =>
  document.documentElement.scrollWidth > window.innerWidth ? [`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`] : [];

function listed(): string[] {
  const wrong = sideways();
  const group = document.querySelector("[data-testid=approval-group-lesson]");
  if (!group) return [...wrong, "no Lessons group is drawn"];
  if (!group.textContent?.includes("Lessons")) wrong.push("the group is not headed Lessons");
  if (rows().length !== 3) wrong.push(`${rows().length} rows are drawn, not the 3 lesson decisions`);
  for (const r of rows()) for (const b of r.querySelectorAll("button")) if (b.getBoundingClientRect().right > window.innerWidth + 0.5) wrong.push(`"${b.textContent}" runs past the window's right edge`);
  return wrong;
}

window.__witness = {
  cases: [
    { name: "desktop", width: 1280 },
    { name: "phone", width: 390 },
  ],
  ready: () => rows().length === 3,
  stages: [
    { name: "list-light", run: async () => (theme("light"), await settle(), listed()) },
    { name: "list-dark", run: async () => (theme("dark"), await settle(), listed()) },
    {
      name: "confusion-peek-light",
      run: async () => {
        theme("light");
        rows()
          .find((r) => r.textContent?.includes("L-4"))
          ?.querySelector<HTMLElement>("[data-testid=approval-open]")
          ?.click();
        await settle();
        const peek = document.querySelector<HTMLElement>("[data-testid=approval-peek]");
        if (!peek) return ["the confusion opens no peek"];
        const wrong = sideways();
        if (!peek.textContent?.includes("The house style sets every letter in 11 pt")) wrong.push("the peek does not carry the other side");
        if (!peek.textContent?.includes("Edit as recommended")) wrong.push("the peek does not offer the recommended answer");
        return wrong;
      },
    },
  ],
};
