// The Releases page's overview (REQ-43 r3 BC-14..BC-17): releases shipped over the last days and the
// issues they carried, the flow of the list's releases by state each with its count, and what shipped
// each day in the reader's days, the home's chart by the home's rule (`project-home.ts:shipDaysOf`).
// The flow counts the rows the list draws (L-57): a release a later one carries folds under it there,
// so it is counted once, as its carrier's line.

import { PROJECT_HOME_DAYS, shipDaysOf } from "@forge/contracts/project-home";
import { RELEASE_STATES } from "@forge/contracts/releases";
import { OverviewBand, readerDays, stateFlowOf } from "@/design";
import { ShippedChart } from "./shipped-chart";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import type { ReleaseSummary } from "../types";

export function ReleasesBand({ releases, rows }: { releases: readonly ReleaseSummary[]; rows: readonly ReleaseSummary[] }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const { dayOf, today } = readerDays();
  const days = shipDaysOf(releases, dayOf, today);
  return (
    <OverviewBand
      label={t("releases.band.label")}
      testId="releases-band"
      figures={[
        { key: "shipped", value: days.reduce((n, d) => n + d.releases, 0), label: t("releases.band.shipped", { n: PROJECT_HOME_DAYS }) },
        { key: "issues", value: days.reduce((n, d) => n + d.issues, 0), label: t("releases.band.issues") },
      ]}
      flow={stateFlowOf("releaseState", RELEASE_STATES, rows.map((r) => r.state), language)}
      chart={<ShippedChart days={days} testId="releases-band-chart" />}
    />
  );
}
