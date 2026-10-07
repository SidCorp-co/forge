"use client";

import { useState } from "react";
import Link from "next/link";
import {
  PageSection,
  PageSectionBody,
  Heartbeat,
  SectionTitle,
  enumLabel,
} from "@/design";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { formatElapsed, silenceMark } from "../derive";
import type { PulseLiveness, PulseThresholds } from "../types";
import { RecordPanel } from "./record-panel";

const MARK_TEXT: Record<string, string> = {
  calm: "text-muted",
  warn: "text-amber",
  alarm: "text-red",
};

export interface LivenessBandProps {
  liveness: PulseLiveness;
  thresholds: PulseThresholds;
}

/** Section 1 — is the control plane executing? */
export function LivenessBand({ liveness, thresholds }: LivenessBandProps) {
  const [panel, setPanel] = useState<"liveJobs" | "stuckRuns" | null>(null);
  const mark = silenceMark(liveness.silenceSeconds, thresholds);
  const live = liveness.jobsRunning + liveness.jobsQueued + liveness.jobsHeld;
  const t = useCopy();
  const language = useInterfaceLanguage();

  const silenceText =
    liveness.silenceSeconds === null ? t("overview.live2.neverRan") : t("overview.live2.silentFor", { age: formatElapsed(liveness.silenceSeconds, t) });

  return (
    <PageSection>
      <PageSectionBody className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <SectionTitle className="fg-h3">{t("overview.live2.title")}</SectionTitle>
          <p className={`fg-body-sm ${MARK_TEXT[mark]}`}>
            {silenceText}
            {mark === "alarm" ? t("overview.live2.pastAlarm") : null}
            {mark === "warn" ? t("overview.live2.pastWarn") : null}
          </p>
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <button
            type="button"
            onClick={() => setPanel(panel === "liveJobs" ? null : "liveJobs")}
            aria-label={t("overview.live2.liveJobsAria", { n: live })}
            className="rounded-sm px-1 py-0.5 text-left hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
          >
            <span className="fg-h2 block tabular-nums">{live}</span>
            <span className="fg-body-sm text-muted">
              {t("overview.live2.liveJobs", { running: liveness.jobsRunning, queued: liveness.jobsQueued, held: liveness.jobsHeld })}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setPanel(panel === "stuckRuns" ? null : "stuckRuns")}
            aria-label={t("overview.live2.stuckAria", { n: liveness.stuckRuns.total })}
            className="rounded-sm px-1 py-0.5 text-left hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
          >
            <span className="fg-h2 block tabular-nums">{liveness.stuckRuns.total}</span>
            <span className="fg-body-sm text-muted">{t("overview.live2.stuck")}</span>
          </button>

          <Link
            href="/runners"
            aria-label={t("overview.live2.runnersAria", { online: liveness.devices.online, total: liveness.devices.total })}
            className="rounded-sm px-1 py-0.5 hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
          >
            <span className="fg-h2 block tabular-nums">
              {liveness.devices.online}/{liveness.devices.total}
            </span>
            <span className="fg-body-sm text-muted">
              {t("overview.live2.runnersOnline")}
              {liveness.devices.draining > 0 ? ` · ${t("overview.live2.draining", { n: liveness.devices.draining })}` : ""}
            </span>
          </Link>
        </div>

        {liveness.heartbeat.length > 0 ? (
          <Heartbeat
            days={liveness.heartbeat.map((d) => ({ date: d.date, value: d.issueRuns }))}
            label={`${t("overview.live2.heartbeat", { days: liveness.heartbeat.length })} ${
              liveness.heartbeat.every((d) => d.issueRuns === 0)
                ? t("overview.live2.heartbeatNone")
                : t("overview.live2.heartbeatBusiest", { n: Math.max(...liveness.heartbeat.map((d) => d.issueRuns)) })
            }`}
          />
        ) : (
          <p className="fg-body-sm text-muted">
            {t("overview.live2.noHeartbeat", { live, stuck: liveness.stuckRuns.total })}
          </p>
        )}

        {panel === "liveJobs" ? (
          <RecordPanel
            title={t("overview.live2.liveJobsTitle")}
            total={liveness.liveJobs.total}
            records={liveness.liveJobs.shown.map((j) => ({
              key: j.jobId,
              label: j.issueRef ?? enumLabel("jobType", j.type, language),
              detail: `${enumLabel("jobType", j.type, language)} · ${j.projectSlug}`,
              href: j.issueDocId
                ? `/projects/${j.projectSlug}/issues/${j.issueDocId}`
                : `/ops?run=${j.runId}`,
              ageSeconds: j.ageSeconds,
            }))}
            onClose={() => setPanel(null)}
          />
        ) : null}
        {panel === "stuckRuns" ? (
          <RecordPanel
            title={t("overview.action.stuckRuns")}
            total={liveness.stuckRuns.total}
            records={liveness.stuckRuns.shown.map((r) => ({
              key: r.runId,
              label: r.issueRef ?? t("overview.awaiting.runTitle"),
              detail: r.projectSlug,
              href: r.issueDocId
                ? `/projects/${r.projectSlug}/issues/${r.issueDocId}`
                : `/ops?run=${r.runId}`,
              ageSeconds: r.ageSeconds,
            }))}
            onClose={() => setPanel(null)}
          />
        ) : null}
      </PageSectionBody>
    </PageSection>
  );
}
