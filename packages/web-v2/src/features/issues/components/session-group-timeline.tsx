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
import { Badge, Card, CardContent, CardHeader, CardTitle, Icon, MonoTag } from "@/design";
import {
  deriveSessionTimeline,
  FRESH_REASON_COPY,
  type SessionTimelineEntry,
} from "../derive";
import type { IssueAgentSession } from "../types";

interface SessionGroupTimelineProps {
  sessions: IssueAgentSession[];
}

export function SessionGroupTimeline({ sessions }: SessionGroupTimelineProps) {
  const entries = deriveSessionTimeline(sessions);

  // Render nothing on legacy issues with no group metadata at all — avoids a
  // noisy empty card when continuity simply can't be derived (AC9).
  const hasGroup = entries.some((e) => e.continuity !== "unknown");
  if (entries.length === 0 || !hasGroup) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Session continuity</CardTitle>
      </CardHeader>
      <CardContent>
        {entries.map((entry, i) => (
          <TimelineRow key={entry.id} entry={entry} isLast={i === entries.length - 1} />
        ))}
      </CardContent>
    </Card>
  );
}

const CONTINUITY_META: Record<
  "resumed" | "fresh",
  { glyph: string; label: string; tone: "neutral" | "accent" }
> = {
  resumed: { glyph: "↻", label: "Resumed", tone: "neutral" },
  fresh: { glyph: "✦", label: "Fresh", tone: "accent" },
};

function TimelineRow({ entry, isLast }: { entry: SessionTimelineEntry; isLast: boolean }) {
  const [showOps, setShowOps] = useState(false);
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
            fresh session
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {cont && (
            <Badge tone={cont.tone}>
              <span className="mr-0.5" aria-hidden>
                {cont.glyph}
              </span>
              {cont.label}
            </Badge>
          )}
          {entry.groupLabel && <Badge tone="cobalt">{entry.groupLabel}</Badge>}
          {entry.jobType && (
            <span className="font-mono text-[12.5px] font-bold text-fg">{entry.jobType}</span>
          )}
          <span className="fg-body-sm capitalize text-muted">{entry.status}</span>
        </div>

        <button
          type="button"
          onClick={() => setShowOps((v) => !v)}
          className="fg-caption mt-1.5 inline-flex items-center gap-1 text-muted transition-colors hover:text-fg"
          aria-expanded={showOps}
        >
          <Icon name={showOps ? "chevronDown" : "chevronRight"} size={12} />
          Operator details
        </button>
        {showOps && (
          <div className="mt-2 flex flex-wrap gap-2 border-t border-line-subtle pt-2">
            {entry.claudeShort && <OpsTag label="claude" value={entry.claudeShort} />}
            {entry.deviceShort && <OpsTag label="device" value={entry.deviceShort} />}
            <OpsTag label="status" value={entry.status} />
            {entry.continuity === "fresh" && entry.freshReason && (
              <span className="fg-caption text-muted">{FRESH_REASON_COPY[entry.freshReason]}</span>
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
