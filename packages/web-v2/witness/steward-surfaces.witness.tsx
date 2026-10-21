// The steward's surfaces that read a project as a whole, witnessed as drawn (REQ-48 lane A): the
// Dashboard (Needs you capped at three with "+n more" to Approvals, at risk led by what is stuck, the
// feedback figures counting stuck), the status report (Stuck and Needs you before Shipped), /attention
// (each project's decisions read by its total) and the pipeline board (a card's stuck reason). The
// records' pages are `steward-records.witness.tsx`. At 390 px nothing scrolls sideways.
//
//   pnpm --filter web-v2 witness witness/steward-surfaces.witness.tsx --out <dir>

import { AttentionScreen } from "@/features/attention";
import { PipelineBoard } from "@/features/pipeline";
import { BaFigures } from "@/features/project-dashboard/components/ba-figures";
import { ProjectHome } from "@/features/project-home";
import { StatusReport } from "@/features/project-status/components/status-report";
import { APPROVALS_READ } from "@/test/approvals-read";
import { clock, FP, has, ISSUE_STUCK, Live, mountSurfaces, PH, type Surface, WITNESS_STATUS } from "./steward.fixture";

const SURFACES: Surface[] = [
  {
    name: "dashboard",
    path: "/projects/hop",
    render: () => (
      <Live>
        <BaFigures slug="hop" requirements={[{ state: "in_delivery", count: 4 }, { state: "agreed", count: 2 }] as never} feedback={{ open: 12, untriaged: 2, stuck: 1 }} release={null} clock={clock} />
        <ProjectHome projectId={PH} slug="hop" />
      </Live>
    ),
    check: () => [...has("Needs you", `+${APPROVALS_READ.total - 3} more`), ...has("at risk", "REQ-45"), ...has("at risk", "no master serves")],
  },
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
    check: () => [...has("attention", "FB-135"), ...has("attention", `+${APPROVALS_READ.total - 3} more`)],
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
