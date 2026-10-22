// The steward's question in Approvals, witnessed as drawn (REQ-48 BC-11): its row names the answer
// its ✓ sends and how many more its peek holds, and the peek says on each of Forge's fixed answers
// (open, keep, drop), once, what it does to the item, the steward's recommended one first and marked,
// with the steward's one line on why (REQ-48 r3 BC-14). At 390 px the peek is its full-screen sheet and nothing scrolls sideways.
// The decision is `src/test/approvals-read.ts` `STEWARD_DECISION`, built from the contract's own
// labels and effects.
//
//   pnpm --filter web-v2 witness witness/steward-approvals.witness.tsx --out <dir>

import { needsYouDecisionsSchema } from "@forge/contracts/needs-you-decisions";
import { ApprovalsScreen } from "@/features/approvals";
import { APPROVALS_READ, STEWARD_DECISION } from "@/test/approvals-read";
import { has, Live, mountSurfaces, PH, type Surface } from "./steward.fixture";

const QUESTIONS = [STEWARD_DECISION, ...APPROVALS_READ.decisions.filter((d) => d.topic === "question")];
const READ = needsYouDecisionsSchema.parse({ ...APPROVALS_READ, total: QUESTIONS.length, decisions: QUESTIONS, notDecisions: [] });

// the fixture's core answers the rest; this project's decisions are the steward's question and a run's
const fixtureFetch = window.fetch;
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(String(input), "http://forge.test").pathname.replace(/^\/api/, "");
  if (path === `/projects/${PH}/needs-you/decisions`) return new Response(JSON.stringify(READ), { headers: { "content-type": "application/json" } });
  return fixtureFetch(input, init);
};

const row = () =>
  [...document.querySelectorAll<HTMLElement>("[data-testid=approval-row]")].find((r) => r.querySelector("[data-testid=approval-open]")?.textContent?.includes(STEWARD_DECISION.key));
const recommended = STEWARD_DECISION.answers.find((a) => a.recommended);
if (!recommended) throw new Error(`the fixture's ${STEWARD_DECISION.key} decision recommends no answer`);

const approvals = () => (
  <Live>
    <ApprovalsScreen projectId={PH} slug="hop" />
  </Live>
);

const SURFACES: Surface[] = [
  {
    name: "steward-question-row",
    path: "/projects/hop/approvals",
    render: approvals,
    check: () => {
      const r = row();
      if (!r) return [`no row for ${STEWARD_DECISION.key}`];
      const sends = r.querySelector("[data-testid=approval-approve]")?.textContent ?? "";
      return [
        ...(sends === recommended.label ? [] : [`the row's ✓ reads "${sends}", not the steward's recommended "${recommended.label}"`]),
        ...has("the row's other answers", `${STEWARD_DECISION.answers.length - 1} other answers`),
      ];
    },
  },
  {
    name: "steward-question-peek",
    path: "/projects/hop/approvals",
    render: approvals,
    // the dark stage is the same mount, its peek already open: a second press would close it
    open: () => {
      if (!document.querySelector("[data-testid=approval-peek]")) row()?.querySelector<HTMLElement>("[data-testid=approval-open]")?.click();
    },
    check: () => {
      const peek = document.querySelector<HTMLElement>("[data-testid=approval-peek]");
      if (!peek) return ["the steward question's peek is not open"];
      const lines = [...peek.querySelectorAll<HTMLElement>("[data-testid=approval-peek-answer]")];
      const wrong: string[] = [];
      for (const a of STEWARD_DECISION.answers) {
        const line = lines.find((l) => l.dataset.answer === a.id);
        if (!line) {
          wrong.push(`the peek draws no line for "${a.label}"`);
          continue;
        }
        if (!a.effect || !line.textContent?.includes(a.effect)) wrong.push(`"${a.label}" does not say what it does: "${a.effect ?? ""}" is not drawn`);
        if (line.getBoundingClientRect().height === 0) wrong.push(`"${a.label}"'s effect line is drawn with no height`);
        if (line.textContent?.includes("Recommended") !== a.recommended) wrong.push(`"${a.label}" is ${a.recommended ? "not " : ""}marked recommended`);
      }
      return [...wrong, ...has("the steward's why", STEWARD_DECISION.recommended?.why ?? "")];
    },
  },
];

mountSurfaces(SURFACES);
