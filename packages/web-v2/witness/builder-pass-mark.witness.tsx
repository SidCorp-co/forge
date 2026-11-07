// A builder's own pass counted under the cutover, witnessed at phone and desktop width in both themes
// (ISS-683, REQ-74 BC-2; contracts `verified-rule.ts:BUILDER_PASS_CUTOVER`): the Criteria tab and the
// release page's Technical view list it as met, marked with the one word "Builder", and mark no other.
// A builder's pass that never counts (K91, dev.318) is drawn not judged, marked "Builder's pass", and
// left out of Met.
//
//   pnpm --filter web-v2 witness witness/builder-pass-mark.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { IssueCriteria } from "@/features/issues/components/issue-criteria";
import type { IssueDetail } from "@/features/issues/types";
import { ChangeDetail, checksByIssue } from "@/features/releases/components/release-row-detail";
import { releasePage } from "@/test/release-page";
import "./entry";
import { InRouter } from "./router";

const AT = "2026-10-20T09:12:00.000Z";
const judged = (verdict: "pass" | "short", reason: string, countedUnderCutover = false, notCounted: { code: string; detail: string } | null = null) => ({
  verdict,
  reason,
  identityKind: "commit",
  commitSha: "8e0e7dae6".padEnd(40, "0"),
  authorAgency: "agent",
  createdAt: AT,
  countedUnderCutover,
  notCounted,
});
const BY_BUILDER = { code: "VERDICT_BY_BUILDER", detail: "recorded by the run that built this issue" };
const criteria = [
  { id: "k1", n: 1, statement: "The release page names who approved it", position: 0, requirementCriterionId: null, latest: judged("pass", "passed by the building run", true) },
  { id: "k2", n: 2, statement: "The page shows the version and date", position: 1, requirementCriterionId: null, latest: judged("pass", "judged by K72 on the running build") },
  { id: "k3", n: 3, statement: "Each release opens on highlights", position: 2, requirementCriterionId: null, latest: judged("short", "opens on highlights; the clip is missing") },
  { id: "k4", n: 4, statement: "Each highlight carries a picture", position: 3, requirementCriterionId: null, latest: judged("pass", "passed by the building run after the cutover", false, BY_BUILDER) },
];

window.fetch = async (input: RequestInfo | URL) =>
  String(input).includes("/issues/witness/criteria")
    ? new Response(JSON.stringify({ criteria }), { status: 200, headers: { "content-type": "application/json" } })
    : new Response("{}", { status: 404, headers: { "content-type": "application/json" } });

const base = releasePage({ view: "developer" });
const [req] = base.requirements;
if (!req) throw new Error("the fixture has no requirement");
const page = { ...base, requirements: [{ ...req, proven: req.proven.map((p) => (p.n === 2 ? { ...p, countedUnderCutover: true } : p)) }] };
const [change] = page.improvements;
if (!change) throw new Error("the fixture has no change");

const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};

createRoot(document.getElementById("root") as HTMLElement).render(
  <InRouter>
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <div className="min-h-screen bg-app p-4">
        <div className="mx-auto grid max-w-3xl grid-cols-[minmax(0,1fr)] gap-8">
          <IssueCriteria issue={{ id: "witness", status: "awaiting_release" } as IssueDetail} checklist={[]} canWrite={false} />
          <div data-testid="release-row">
            <ChangeDetail page={page} change={change} checks={checksByIssue(page).get("ISS-1")} reach={{ authed: true }} />
          </div>
        </div>
      </div>
    </QueryClientProvider>
  </InRouter>,
);

const settle = () => new Promise((r) => setTimeout(r, 100));

function reads(): string[] {
  const wrong: string[] = [];
  const issueMarks = [...document.querySelectorAll("[data-testid$=-builder]")].map((e) => `${e.getAttribute("data-testid")}:${e.textContent}`);
  if (issueMarks.join() !== "criterion-1-builder:Builder") wrong.push(`the Criteria tab marks ${issueMarks.join() || "nothing"}, not criterion 1 alone as "Builder"`);
  const releaseMarks = [...document.querySelectorAll("[data-testid=release-row] [data-testid=proof-builder-mark]")].map((e) => e.closest("li")?.textContent ?? "");
  if (releaseMarks.length !== 1 || !releaseMarks[0]?.startsWith("✓#2")) wrong.push(`the release row marks ${JSON.stringify(releaseMarks)}, not #2 alone`);
  const word = document.querySelector("[data-testid=criterion-1-builder]");
  if (word && word.getBoundingClientRect().width === 0) wrong.push("the Criteria tab's Builder word is not drawn at this width");
  const only = document.querySelector("[data-testid=criterion-4-builder-only]");
  if (only?.textContent !== "Builder's pass" || only.getBoundingClientRect().width === 0) wrong.push("criterion 4 is not marked \"Builder's pass\" at this width");
  if (document.querySelector("[data-testid=criterion-4-verdict]")?.textContent !== "–") wrong.push("criterion 4, a builder's pass that never counts, is not drawn not judged");
  const pills = [...document.querySelectorAll("#criteria fieldset button")].map((b) => b.textContent);
  if (!pills.includes("Met 3") || !pills.includes("Not judged 1")) wrong.push(`the pills read ${pills.join(", ")}, not Met 3 and Not judged 1`);
  if (document.documentElement.scrollWidth > window.innerWidth) wrong.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`);
  return wrong;
}

window.__witness = {
  cases: [
    { name: "phone", width: 390 },
    { name: "desktop", width: 1440 },
  ],
  ready: () => Boolean(document.querySelector("[data-testid=criterion-4-verdict]")) && Boolean(document.querySelector("[data-testid=page-row-detail]")),
  stages: [
    { name: "light", run: async () => (theme("light"), await settle(), reads()) },
    { name: "dark", run: async () => (theme("dark"), await settle(), reads()) },
  ],
};
