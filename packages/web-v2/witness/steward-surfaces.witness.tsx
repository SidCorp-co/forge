// The steward's surfaces that read a project as a whole, witnessed as drawn (REQ-48 lane A): the
// status report (Stuck and Needs you before Shipped), /attention
// (each project's decisions read by its total) and the pipeline board (a card's stuck reason); the
// Dashboard is witnessed whole in `project-dashboard.witness.tsx` (ISS-1067). The records' pages are `steward-records.witness.tsx`. At 390 px nothing scrolls sideways.
//
//   pnpm --filter web-v2 witness witness/steward-surfaces.witness.tsx --out <dir>

import { AttentionScreen } from "@/features/attention";
import { PipelineBoard } from "@/features/pipeline";
import { StatusReport } from "@/features/project-status/components/status-report";
import { APPROVALS_READ } from "@/test/approvals-read";
import { clock, FP, has, ISSUE_STUCK, Live, mountSurfaces, type Surface, WITNESS_STATUS } from "./steward.fixture";

const SURFACES: Surface[] = [
  {
    name: "status-report",
    path: "/projects/hop/status",
    render: () => (
      <div className="mx-auto max-w-4xl px-4 py-6">
        <StatusReport s={WITNESS_STATUS} slug="hop" clock={clock} />
      </div>
    ),
    check: () => [...has("Stuck", "REQ-45"), ...has("Stuck", "FB-74"), ...has("Needs you", "FB-135")],
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
  {
    name: "pipeline-board",
    path: "/projects/hop/pipeline",
    render: () => (
      <Live>
        <PipelineBoard scope={{ projectId: FP, slug: "hop" }} />
      </Live>
    ),
    check: () => has("the board", ISSUE_STUCK.reason),
  },
];

mountSurfaces(SURFACES);
