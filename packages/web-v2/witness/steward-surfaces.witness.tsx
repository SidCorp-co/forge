// The steward's surfaces that read a project as a whole, witnessed as drawn (REQ-48 lane A): the
// status report (Stuck and Needs you before Shipped), /attention
// (each project's decisions read by its total) and the pipeline board (a card's stuck reason); the
// Dashboard is witnessed whole in `project-dashboard.witness.tsx` (ISS-1067). The records' pages are `steward-records.witness.tsx`. At 390 px nothing scrolls sideways.
//
//   pnpm --filter web-v2 witness witness/steward-surfaces.witness.tsx --out <dir>

import { AttentionScreen } from "@/features/attention";
import { StatusReport } from "@/features/project-status/components/status-report";
import { APPROVALS_READ } from "@/test/approvals-read";
import { clock, FP, has, ISSUE_STUCK, lacks, Live, mountSurfaces, type Surface, WITNESS_STATUS } from "./steward.fixture";

const SURFACES: Surface[] = [
  {
    name: "status-report",
    path: "/projects/hop/status",
    render: () => (
      <div className="mx-auto max-w-4xl px-4 py-6">
        <StatusReport s={WITNESS_STATUS} slug="hop" clock={clock} />
      </div>
    ),
    // each row leads with its title, its key the title's hover (ISS-1072)
    check: () => [
      ...has("Stuck", "Checkout reaches the clinic"),
      ...has("Stuck", "Board loses a card on refresh"),
      ...has("Needs you", WITNESS_STATUS.needsYou?.decisions.find((d) => d.key === "FB-135")?.question ?? "FB-135"),
      ...lacks("a row", "FB-135"),
      ...lacks("a row", "REQ-45"),
      ...lacks("a row", "FB-74"),
    ],
  },
  {
    name: "attention",
    path: "/attention",
    render: () => (
      <Live>
        <AttentionScreen />
      </Live>
    ),
    // a decision is named by its title, its key the title's hover (ui-copy-rule 10)
    check: () => [...has("attention", APPROVALS_READ.decisions.find((d) => d.key === "FB-135")?.title ?? "FB-135"), ...has("attention", `+${APPROVALS_READ.total - 3} more`)],
  },
];

mountSurfaces(SURFACES);
