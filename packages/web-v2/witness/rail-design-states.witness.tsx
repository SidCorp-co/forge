// The issue rail's Proposes rows, witnessed at phone and desktop width (ISS-569, release judge K36 on
// dev.273): each row reads the state of the revision drawn under the issue, never the flow's head
// status. ISS-498's body is the one forge-dev served on 2026-10-22 — r21 returned under it, the flow
// since approved at r22 — with the `state` core now derives (`design-issue.ts:proposesWorkflowsOf`);
// the rail read "r21 · Approved" before the fix. The other rows cover the revision states left.
//
//   pnpm --filter web-v2 witness witness/rail-design-states.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { RailTraceRows } from "@/features/issues/components/rail-trace";
import type { IssueDetail } from "@/features/issues/types";
import "./entry";
import { InRouter } from "./router";

type Proposed = NonNullable<IssueDetail["proposesWorkflows"]>[number];

const ISSUES: Record<string, { rows: Proposed[]; reads: string[] }> = {
  "ISS-498": {
    rows: [
      { workflowId: "7645aa5c-64f4-4e48-90c1-20afc840a8ab", flow: "issue-delivery", title: "Issue to release", designStatus: "approved", revision: 21, decision: "return", state: "returned" },
    ],
    reads: ["r21 · Returned"],
  },
  "several designs": {
    rows: [
      { workflowId: "w-current", flow: "requirement-lifecycle", title: "Requirement lifecycle", designStatus: "approved", revision: 15, decision: "approve", state: "current" },
      { workflowId: "w-superseded", flow: "feedback-lifecycle", title: "Feedback lifecycle", designStatus: "approved", revision: 14, decision: "approve", state: "superseded" },
      { workflowId: "w-proposed", flow: "feedback-triage", title: "Feedback triage", designStatus: "proposed", revision: 3, decision: null, state: "proposed" },
    ],
    reads: ["r15 · Approved", "r14 · Superseded", "r3 · Awaiting approval"],
  },
};
const keys = Object.keys(ISSUES);

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

createRoot(document.getElementById("root") as HTMLElement).render(
  <InRouter at="/projects/forge/issues" pattern="/projects/$slug/issues">
    <QueryClientProvider client={client}>
      <div className="bg-app" style={{ padding: 16, display: "grid", gap: 16 }}>
        {keys.map((k) => (
          <section key={k} data-issue={k} style={{ maxWidth: 320, border: "1px solid #ccc", padding: 8 }}>
            <div className="fg-body-sm" style={{ fontWeight: 600 }}>
              {k}
            </div>
            <RailTraceRows issue={{ buildsWorkflow: null, proposesWorkflows: ISSUES[k]?.rows ?? [], shippedIn: null }} slug="forge" standing={undefined} />
          </section>
        ))}
      </div>
    </QueryClientProvider>
  </InRouter>,
);

window.__witness = {
  cases: [
    { name: "desktop", width: 1280 },
    { name: "phone", width: 390 },
  ],
  ready: () => document.querySelectorAll('[data-testid="rail-workflow"]').length === 4,
  probe: () => {
    const wrong: string[] = [];
    for (const k of keys) {
      const section = document.querySelector(`section[data-issue="${k}"]`) as HTMLElement;
      const rows = [...section.querySelectorAll('[data-testid="rail-workflow"]')].map((r) => (r as HTMLElement).innerText.replace(/\n/g, " / "));
      ISSUES[k]?.reads.forEach((want, i) => {
        if (!rows[i]?.includes(want)) wrong.push(`${k}: row ${i + 1} reads "${rows[i] ?? "nothing"}", not "${want}"`);
      });
      console.log(`RAIL ${k}: ${rows.join(" | ")}`);
    }
    return wrong;
  },
};
