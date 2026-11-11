// The Requirements page's overview (REQ-43 r3 BC-14..BC-17): how many are in play and the share of
// their criteria proven, the flow of their states each with its count, and criteria proven by area.
// Counted over the very rows the list under it holds (L-57), by the rule the home's Product stage
// reads (`project-home.ts:criteriaByAreaOf`), so neither can disagree with the other.

import { criteriaByAreaOf, requirementInPlay } from "@forge/contracts/project-home";
import { REQUIREMENT_STATES } from "@forge/contracts/requirements";
import { OverviewBand, ShareBars, shareOf, stateFlowOf } from "@/design";
import { useNeedsYou } from "@/features/needs-you";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import type { RequirementSummary } from "../types";

/**
 * What waits on the person here is the Requirements count of the Needs you read the rail badge reads
 * (ISS-1198 c3), the rows the list's Needs you group holds; the band reads it itself, so the screen
 * coordinates no more modules.
 */
export function RequirementsBand({ projectId, rows }: { projectId: string; rows: readonly RequirementSummary[] }) {
  const waiting = useNeedsYou(projectId).data?.areas.requirements.you ?? null;
  const t = useCopy();
  const language = useInterfaceLanguage();
  const { criteria, areas } = criteriaByAreaOf(rows);
  const share = shareOf(criteria.proven, criteria.total);
  return (
    <OverviewBand
      label={t("requirements.band.label")}
      testId="requirements-band"
      figures={[
        { key: "inPlay", value: rows.filter(requirementInPlay).length, label: t("requirements.band.inPlay") },
        { key: "proven", value: `${Math.round(share * 100)}%`, label: t("requirements.band.proven"), ring: share },
        { key: "waiting", value: waiting ?? "…", label: t("requirements.band.waiting") },
      ]}
      flow={stateFlowOf("requirement", REQUIREMENT_STATES, rows.map((r) => r.standing.state), language)}
      chart={
        <ShareBars
          title={t("requirements.band.byArea")}
          testId="requirements-band-chart"
          unit={t("requirements.band.criteria")}
          rows={areas.map((a) => ({ key: a.name ?? "", label: a.name ?? t("requirements.noArea"), part: a.proven, whole: a.total }))}
          emptyText={t("requirements.band.none")}
          reader={{ head: [t("requirements.band.area"), t("requirements.band.provenCol"), t("requirements.band.criteria")] }}
        />
      }
    />
  );
}
