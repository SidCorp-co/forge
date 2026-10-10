import type { ContractStandingDetail, ContractStandingRow, ContractVersionView } from "@/features/contracts/types";
import { ContractScreen } from "@/features/contracts/components/contract-screen";
import { RULE, say, waitingOn } from "./said";
import { Seeded } from "./vi-chrome-requirements";
import type { ChromeScreen } from "./vi-chrome-screens";

// A contract's page for the vi walking test and the record-page witness: a provided contract with a
// version waiting on the viewer, two earlier versions and two consumers. Names and texts are
// placeholder words; whom it waits on and what for are said by their registry keys, as core says them.

const P = "p-contract";
const AT = "2026-10-07T08:00:00.000Z";
const EARLIER = "2026-08-20T08:00:00.000Z";
const EARLIEST = "2026-06-02T08:00:00.000Z";
const project = { id: P, slug: "hop", name: "Hop" };

const version = (v: string, over: Partial<ContractVersionView> = {}): ContractVersionView => ({
  version: v,
  recordedAt: AT,
  classification: "additive",
  approval: "approved",
  decidedAt: AT,
  previous: null,
  changes: [{ element: "orders.total", kind: "field", level: "additive", text: "Them truong" }],
  decisionReason: null,
  ...over,
});

const contract: ContractStandingRow = {
  ref: "hop/orders",
  slug: "orders",
  provider: project,
  direction: "provided",
  title: "Don hang",
  summary: "Doc don hang",
  kind: "openapi",
  lifecycle: "active",
  current: version("1.1.0", { recordedAt: EARLIER, decidedAt: EARLIER }),
  pending: version("2.0.0", { classification: "breaking", approval: "proposed", decidedAt: null }),
  ours: "1.1.0",
  window: null,
  noticeDays: 14,
  consumers: { total: 2, current: 1, behind: 1 },
  state: "proposed",
  touchedAt: AT,
  attentionGroup: "needs_you",
  waitingOn: waitingOn("you", { who: say("standing.who.you"), act: say("contracts.act.approveOrReturn", { v: "2.0.0", measured: "breaking" }), rule: RULE }, { ref: "2.0.0" }),
};

const detail: ContractStandingDetail = {
  generatedAt: AT,
  project,
  contract,
  versions: [
    version("2.0.0", { classification: "breaking", approval: "proposed", decidedAt: null, previous: "1.1.0" }),
    version("1.1.0", { previous: "1.0.0", recordedAt: EARLIER, decidedAt: EARLIER }),
    version("1.0.0", { recordedAt: EARLIEST, decidedAt: EARLIEST }),
  ],
  consumers: [
    { project: { id: "p-b", slug: "ban", name: "Ban" }, builtAgainst: "1.1.0", adoption: "current", self: false },
    { project: { id: "p-c", slug: "kho", name: "Kho" }, builtAgainst: "1.0.0", adoption: "behind", self: false },
  ],
  feedback: [],
  module: { available: false, reason: "r" },
};

export const SCREENS: ChromeScreen[] = [
  {
    name: "Contract detail",
    render: () => (
      <Seeded data={[[["issues", "standing", "contracts", P, "detail", "hop/orders"], detail]]}>
        <ContractScreen projectId={P} slug="hop" contractRef="hop/orders" />
      </Seeded>
    ),
  },
];
