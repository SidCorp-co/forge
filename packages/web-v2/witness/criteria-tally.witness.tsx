// An issue's own criteria tally, witnessed at phone and desktop width (forge-core-eb's ruling of
// 2026-10-14): the strip and the Criteria tab count a short with a pass as met, since a short meets
// its criterion short of its wording and is never proven (contracts `verified-rule.ts`). Neither may
// call that count passing or proven while a short is in it.
//
//   pnpm --filter web-v2 witness witness/criteria-tally.witness.tsx --out <dir>

import type { IssueStandingRow } from "@forge/contracts/issue-standing";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { IssueCriteria } from "@/features/issues/components/issue-criteria";
import { IssueStrip } from "@/features/issues/components/issue-standing-bits";
import type { IssueDetail } from "@/features/issues/types";
import "./entry";
import { InRouter } from "./router";

const AT = "2026-10-14T09:12:00.000Z";
const judged = (verdict: "pass" | "short" | "fail", reason: string, sha: string) => ({
  verdict,
  reason,
  identityKind: "commit",
  commitSha: sha.padEnd(40, "0"),
  authorAgency: "agent",
  createdAt: AT,
});
const criteria = [
  { id: "k1", n: 1, statement: "A design-only issue is refused at awaiting_release by name", position: 0, requirementCriterionId: null, latest: judged("pass", "refused MERGE_DESIGN_ONLY", "8e0e7dae6") },
  { id: "k2", n: 2, statement: "The refusal points at the design_delivered close", position: 1, requirementCriterionId: null, latest: judged("short", "points there; the guide row still says git only", "8e0e7dae6") },
  { id: "k3", n: 3, statement: "A person's hand-back to open carries its reason", position: 2, requirementCriterionId: null, latest: judged("fail", "moved with no reason posted", "8e0e7dae6") },
  { id: "k4", n: 4, statement: "The tally counts a short as met", position: 3, requirementCriterionId: null, latest: null },
];

const standing = {
  state: "in_progress",
  step: "test",
  tone: "run",
  attentionGroup: "running",
  criteria: { total: 4, met: 2, failing: 1, skipped: 0 },
  requirement: null,
  module: null,
  feedback: [],
  feedbackDropped: [],
  lease: null,
  blockedBy: [],
  blocks: [],
  owner: null,
  touchedAt: AT,
} as unknown as IssueStandingRow["standing"];

window.fetch = async (input: RequestInfo | URL) =>
  String(input).includes("/issues/witness/criteria")
    ? new Response(JSON.stringify({ criteria }), { status: 200, headers: { "content-type": "application/json" } })
    : new Response("{}", { status: 404, headers: { "content-type": "application/json" } });

const root = document.getElementById("root");
if (!root) throw new Error("the page has no #root");
createRoot(root).render(
  <InRouter>
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <div className="mx-auto max-w-3xl space-y-6 p-4">
        <IssueStrip standing={standing} />
        <IssueCriteria issue={{ id: "witness", status: "in_progress" } as IssueDetail} projectId="p1" checklist={[]} canWrite={false} requirementKey={null} />
      </div>
    </QueryClientProvider>
  </InRouter>,
);

const strip = () => document.querySelector("[data-testid=issue-strip]");
const pills = () => [...document.querySelectorAll("button")].map((b) => b.textContent?.trim() ?? "");
const SAYS_PROVEN = /passing|proven/i;

window.__witness = {
  cases: [
    { name: "desktop-1440", width: 1440 },
    { name: "phone-390", width: 390 },
  ],
  ready: () => Boolean(strip()) && Boolean(document.querySelector("[data-testid=criterion-2-verdict]")),
  probe: () => {
    const wrong: string[] = [];
    const said = strip()?.textContent ?? "";
    if (!said.includes("2 of 4 met")) wrong.push(`the strip reads "${said}", not "2 of 4 met"`);
    if (SAYS_PROVEN.test(said)) wrong.push(`the strip calls a tally holding a short passing or proven: "${said}"`);
    const met = pills().find((p) => /^Met \d/.test(p));
    if (met !== "Met 2") wrong.push(`the Criteria tab's met pill reads "${met ?? "missing"}", not "Met 2"`);
    for (const p of pills()) if (SAYS_PROVEN.test(p)) wrong.push(`a Criteria tab pill reads "${p}"`);
    return wrong;
  },
};
