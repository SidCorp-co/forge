"use client";

import {
  BulletBar,
  PageSection,
  PageSectionBody,
  PageSectionTitle,
  SankeyFlow,
  SectionTitle,
  Waffle,
  enumLabel,
  sentenceCase,
} from "@/design";
import { TONE_META } from "@/design/status";
import { failureReasonLabel } from "@/features/sessions/types";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { formatElapsed, qualityRates } from "../derive";
import type { PulseQuality } from "../types";

export interface QualitySectionProps {
  quality: PulseQuality;
}

/** Section 5 — is the output any good? */
export function QualitySection({ quality }: QualitySectionProps) {
  const rates = qualityRates(quality);
  const t = useCopy();
  const language = useInterfaceLanguage();
  const { finished, reopened, rework, runFailure, sessionFailures, pipelineFlow } = quality;

  return (
    <PageSection>
      <PageSectionBody className="flex flex-col gap-4">
        <SectionTitle className="fg-h3">{t("overview.quality.title")}</SectionTitle>

        {rates.finishedTotal > 0 ? (
          <Waffle
            categories={[
              {
                key: "merged",
                label: t("overview.quality.merged"),
                count: finished.merged,
                color: TONE_META.success.dot,
              },
              {
                key: "closedUnmerged",
                label: t("overview.quality.unmerged"),
                count: finished.closedUnmerged,
                color: TONE_META.attention.dot,
              },
              {
                key: "dropped",
                label: t("overview.quality.dropped"),
                count: finished.dropped,
                color: TONE_META.archived.dot,
              },
            ]}
          />
        ) : (
          <p className="fg-body-sm text-muted">{t("overview.quality.empty")}</p>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <BulletBar
            label={t("overview.quality.mergeEvidence")}
            value={finished.merged}
            total={rates.finishedTotal}
            valueText={t("common.ofTotal", { value: finished.merged, total: rates.finishedTotal })}
          />
          <BulletBar
            label={t("overview.quality.reopened")}
            value={reopened.issues}
            total={rates.finishedTotal}
            valueText={t("overview.quality.reopenedText", { issues: reopened.issues, events: reopened.events })}
          />
          <BulletBar
            label={t("overview.quality.rework")}
            value={rework.fix}
            total={rework.code}
            valueText={rates.reworkRatio === null ? t("overview.quality.reworkNoCode", { fix: rework.fix }) : t("overview.quality.reworkText", { fix: rework.fix, code: rework.code })}
          />
          {(["pipeline", "other"] as const).map((lane) => (
            <BulletBar
              key={lane}
              label={t(`overview.quality.failed.${lane}`)}
              value={runFailure[lane].failed}
              total={runFailure[lane].total}
            />
          ))}
        </div>

        <div className="flex flex-col gap-1">
          <PageSectionTitle className="fg-body-sm text-muted">
            {t("overview.quality.whyFailed", { n: rates.sessionFailureTotal })}
            {rates.unclassifiedShare !== null ? t("overview.quality.unclassified", { pct: Math.round(rates.unclassifiedShare * 100) }) : ""}
          </PageSectionTitle>
          {sessionFailures.length === 0 ? (
            <p className="fg-body-sm text-muted">{t("overview.quality.noFailures")}</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {sessionFailures.map((r) => (
                <li key={r.reason} className="fg-body-sm flex justify-between gap-2">
                  <span className={r.reason === "unclassified" ? "text-subtle" : ""} title={`reason: ${r.reason}`}>
                    {failureReasonLabel(r.reason, language) ?? sentenceCase(r.reason)}
                  </span>
                  <span className="tabular-nums text-muted">{r.count}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <PageSectionTitle className="fg-body-sm text-muted">{t("overview.quality.ran")}</PageSectionTitle>
          {pipelineFlow.length === 0 ? (
            <p className="fg-body-sm text-muted">{t("overview.quality.noJobs")}</p>
          ) : (
            <SankeyFlow
              nodes={pipelineFlow.map((n) => ({
                key: n.type,
                label: enumLabel("jobType", n.type, language),
                count: n.count,
                medianSeconds: n.medianSeconds,
                loop: n.type === "fix",
              }))}
              formatDuration={(s) => (s === null ? "—" : formatElapsed(s, t))}
              label={t("overview.quality.sankeyAria", { list: pipelineFlow.map((n) => `${enumLabel("jobType", n.type, language)}: ${n.count}`).join(", ") })}
            />
          )}
        </div>
      </PageSectionBody>
    </PageSection>
  );
}
