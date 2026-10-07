"use client";

// ISS-376 Part 2 — session-group continuity timeline. Shows, per pipeline step,
// whether it RESUMED the prior same-group Claude session or started FRESH, with
// a humanized group label (Build / Verify) and a connector that links steps
// sharing one session — so build (triage→…→code) reads as one chain and verify
// (review→test→release) as another. Pure FE derivation over
// `issue.agentSessions` (AC9): no raw claudeSessionId / "sessionGroup" key in
// the default view (AC8); legacy rows lacking metadata render without a badge
// rather than erroring.
import { useState } from "react";
import { Badge, PageSection, PageSectionBody, PageSectionHeader, PageSectionTitle, enumLabel, Icon, MonoTag, StatusBadge } from "@/design";
import {
  deriveSessionTimeline,
  type SessionTimelineEntry,
} from "../derive";
import type { IssueAgentSession } from "../types";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";

interface SessionGroupTimelineProps {
  sessions: IssueAgentSession[];
}

export function SessionGroupTimeline({ sessions }: SessionGroupTimelineProps) {
  const entries = deriveSessionTimeline(sessions);
  const t = useCopy();

  // Render nothing on legacy issues with no group metadata at all — avoids a
  // noisy empty card when continuity simply can't be derived (AC9).
  const hasGroup = entries.some((e) => e.continuity !== "unknown");
  if (entries.length === 0 || !hasGroup) return null;

  return (
    <PageSection>
      <PageSectionHeader>
        <PageSectionTitle>{t("issues.session.continuity")}</PageSectionTitle>
      </PageSectionHeader>
      <PageSectionBody>
        {entries.map((entry, i) => (
          <TimelineRow key={entry.id} entry={entry} isLast={i === entries.length - 1} />
        ))}
      </PageSectionBody>
    </PageSection>
  );
}

const CONTINUITY_META: Record<"resumed" | "fresh", { glyph: string; tone: "neutral" | "accent" }> = {
  resumed: { glyph: "↻", tone: "neutral" },
  fresh: { glyph: "✦", tone: "accent" },
};
const KNOWN_GROUPS = new Set(["build", "planning", "verify"]);

function TimelineRow({ entry, isLast }: { entry: SessionTimelineEntry; isLast: boolean }) {
  const [showOps, setShowOps] = useState(false);
  const t = useCopy();
  const language = useInterfaceLanguage();
  const groupLabel = entry.group && KNOWN_GROUPS.has(entry.group) ? t(`issues.session.group.${entry.group as "build" | "planning" | "verify"}`) : entry.groupLabel;
  const cont = entry.continuity === "unknown" ? null : CONTINUITY_META[entry.continuity];
  // A fresh step (not chained to the one above) starts a new session — mark the
  // break, except on the very first row where there is nothing to break from.
  const showBreak = !entry.connectedToPrev;

  return (
    <div className="flex gap-3">
      {/* Left rail: dot + connector. Solid when the prior step shares this
          session (one continuous chain); muted when it's a fresh boundary. */}
      <div className="flex w-[18px] flex-none flex-col items-center">
        <span
          className="mt-0.5 size-3.5 flex-none rounded-full"
          style={{
            background: entry.continuity === "fresh" ? "var(--accent)" : "var(--bg-surface)",
            border: `2px solid ${entry.continuity === "fresh" ? "var(--accent)" : "var(--border-strong)"}`,
          }}
        />
        {!isLast && (
          <span
            className="mt-1 min-h-[26px] w-0.5 flex-1"
            style={{
              background: "var(--border-default)",
              opacity: 1,
            }}
          />
        )}
      </div>

      <div className="min-w-0 flex-1 pb-4">
        {showBreak && (
          <p className="fg-caption mb-1 inline-flex items-center gap-1 text-muted">
            <Icon name="stop" size={10} />
            {t("issues.session.freshBreak")}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {cont && (
            <Badge tone={cont.tone}>
              <span className="mr-0.5" aria-hidden>
                {cont.glyph}
              </span>
              {t(`issues.session.${entry.continuity as "resumed" | "fresh"}`)}
            </Badge>
          )}
          {groupLabel && <Badge tone="cobalt">{groupLabel}</Badge>}
          {entry.jobType && (
            <span className="text-12-5 font-bold text-fg" title={`step: ${entry.jobType}`}>
              {enumLabel("jobType", entry.jobType, language)}
            </span>
          )}
          <StatusBadge family="session" value={entry.status} />
          {/* ISS-411 — surface WHERE this step ran by runner NAME (not a raw
              deviceId UUID). Falls back to the short id on a pre-411 server. */}
          {(entry.deviceName ?? entry.deviceShort) && (
            <span className="fg-caption inline-flex items-center gap-1 text-muted">
              <Icon name="server" size={11} className="align-[-1px]" />
              {entry.deviceName ?? entry.deviceShort}
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={() => setShowOps((v) => !v)}
          className="fg-caption mt-1.5 inline-flex items-center gap-1 text-muted transition-colors hover:text-fg"
          aria-expanded={showOps}
        >
          <Icon name={showOps ? "chevronDown" : "chevronRight"} size={12} />
          {t("issues.live.operatorDetails")}
        </button>
        {showOps && (
          <div className="mt-2 flex flex-wrap gap-2 border-t border-line-subtle pt-2">
            {entry.claudeShort && <OpsTag label="claude" value={entry.claudeShort} />}
            {(entry.deviceName ?? entry.deviceShort) && (
              <OpsTag label="device" value={entry.deviceName ?? entry.deviceShort ?? ""} />
            )}
            <OpsTag label="status" value={entry.status} />
            {entry.continuity === "fresh" && entry.freshReason && (
              <span className="fg-caption text-muted">{t(`issues.session.freshReason.${entry.freshReason}`)}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function OpsTag({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="fg-caption text-muted">{label}</span>
      <MonoTag hue="neutral">{value}</MonoTag>
    </span>
  );
}
