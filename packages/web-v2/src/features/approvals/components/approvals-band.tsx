// The Approvals overview (REQ-43 r3 BC-14): how many decisions wait on the person, the page's own
// count, and the flow of those it holds by whose call each is: the agent's recommendation, one press,
// or the person's own, so the parts read the "Agent recommends" chip beneath (L-57). The topics are
// the groups' heads under it, not repeated here. A decision waits now and core serves no history of
// it, so the band draws no chart (BC-16 is for a state that moves). An empty page's band reads zero.

import type { NeedsYouDecisions } from "@forge/contracts/needs-you-decisions";
import { OverviewBand } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { recommends } from "../derive";

export function ApprovalsBand({ read }: { read: NeedsYouDecisions }) {
  const t = useCopy();
  const recommended = read.decisions.filter(recommends).length;
  return (
    <OverviewBand
      label={t("approvals.band.label")}
      testId="approvals-band"
      figures={[{ key: "waiting", value: read.total, label: t("approvals.band.waiting") }]}
      flow={[
        { key: "recommends", label: t("approvals.chip.recommends"), count: recommended, tone: "ready" },
        { key: "yours", label: t("approvals.band.yours"), count: read.decisions.length - recommended, tone: "you" },
      ]}
    />
  );
}
