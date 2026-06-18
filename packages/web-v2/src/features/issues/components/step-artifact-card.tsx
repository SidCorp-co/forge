"use client";

// ISS-377 Tier-2 per-stage artifact card. One compact, expandable card per
// pipeline stage assembled from the step-handoff payload + that stage's summed
// duration/cost (AC#4/#6). The payload is free-form jsonb, so EVERYTHING here
// is rendered defensively — known string fields become paragraphs, string
// arrays become lists, and anything else (objects, ids) lives in the operator
// JSON expand. Never throws on a missing/odd field; degrades to a "no handoff"
// note. `open` is controlled by the screen so the tracker can expand a card.
import { useState } from "react";
import { Icon } from "@/design";
import type { StageKey } from "@/design/stages";
import type { StageCell, StageCellState } from "../derive";

interface StepArtifactCardProps {
  stage: StageKey;
  label: string;
  cell: StageCell;
  open: boolean;
  onToggle: () => void;
}

const STATE_META: Record<StageCellState, { dot: string; label: string }> = {
  done: { dot: "var(--green-500)", label: "Done" },
  // ISS-509 — current stage uses the pipeline-active (cobalt) token, not flame.
  current: { dot: "var(--pipeline-active)", label: "Current" },
  pending: { dot: "var(--border-default)", label: "Pending" },
  error: { dot: "var(--red-500)", label: "Failed" },
};

// Payload keys handled specially / hidden from the generic body (ids + envelope).
const SKIP_KEYS = new Set(["step", "schema_version", "schemaVersion"]);

function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

/** Coerce a jsonb array value into renderable strings, defensively. */
function toStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const o = item as Record<string, unknown>;
        for (const k of ["path", "file", "title", "name", "test", "what", "step"]) {
          if (typeof o[k] === "string") return o[k] as string;
        }
        try {
          return JSON.stringify(item);
        } catch {
          return String(item);
        }
      }
      return String(item);
    })
    .filter((s) => s && s.trim());
}

export function StepArtifactCard({ stage, label, cell, open, onToggle }: StepArtifactCardProps) {
  const [showRaw, setShowRaw] = useState(false);
  const meta = STATE_META[cell.state];
  const payload = cell.handoff?.payload ?? null;

  // Partition payload into string paragraphs vs string-array lists for the body.
  const paragraphs: { key: string; text: string }[] = [];
  const lists: { key: string; items: string[] }[] = [];
  if (payload && typeof payload === "object") {
    for (const [key, value] of Object.entries(payload)) {
      if (SKIP_KEYS.has(key)) continue;
      if (typeof value === "string" && value.trim()) {
        paragraphs.push({ key, text: value.trim() });
      } else if (Array.isArray(value)) {
        const items = toStrings(value);
        if (items.length) lists.push({ key, items });
      }
    }
  }
  const hasBody = paragraphs.length > 0 || lists.length > 0;

  return (
    <div
      id={`stage-card-${stage}`}
      className="rounded-lg border border-line-subtle bg-surface scroll-mt-24"
      style={open ? { borderColor: "var(--accent)" } : undefined}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left"
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
        <span
          aria-hidden
          className="inline-block size-2 flex-none rounded-full"
          style={{ background: meta.dot }}
        />
        <span className="fg-label font-mono">{label}</span>
        <span className="fg-caption text-muted">{meta.label}</span>
        <span className="ml-auto flex items-center gap-3">
          {cell.durationSeconds != null && (
            <span className="fg-caption inline-flex items-center gap-1 text-muted">
              <Icon name="clock" size={12} />
              {fmtDuration(cell.durationSeconds)}
            </span>
          )}
          <span className="fg-caption inline-flex items-center gap-0.5 text-muted">
            <Icon name="dollar" size={12} />
            {cell.costUsd != null ? cell.costUsd.toFixed(2) : "—"}
          </span>
        </span>
      </button>

      {open && (
        <div className="forge-fade space-y-3 border-t border-line-subtle px-3 py-3">
          {!cell.handoff && !hasBody && (
            <p className="fg-body-sm text-muted">No handoff recorded for this stage.</p>
          )}
          {paragraphs.map((p) => (
            <div key={p.key}>
              <p className="fg-caption uppercase tracking-wide text-muted">{p.key}</p>
              <p className="fg-body-sm whitespace-pre-wrap">{p.text}</p>
            </div>
          ))}
          {lists.map((l) => (
            <div key={l.key}>
              <p className="fg-caption uppercase tracking-wide text-muted">{l.key}</p>
              <ul className="fg-body-sm list-disc space-y-0.5 pl-5">
                {l.items.map((item, i) => (
                  <li key={i} className="break-words">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {cell.handoff && (
            <div className="border-t border-line-subtle pt-2">
              <button
                type="button"
                onClick={() => setShowRaw((v) => !v)}
                className="fg-caption inline-flex items-center gap-1 text-muted transition-colors hover:text-fg"
                aria-expanded={showRaw}
              >
                <Icon name={showRaw ? "chevronDown" : "chevronRight"} size={12} />
                Operator details
              </button>
              {showRaw && (
                <div className="mt-2 space-y-2">
                  <p className="fg-caption text-muted">
                    attempt {cell.handoff.attempt}
                    {cell.handoff.pipelineRunId ? ` · run ${cell.handoff.pipelineRunId}` : ""}
                  </p>
                  <pre className="max-h-72 overflow-auto rounded-md bg-app/60 p-2 text-[11px] leading-snug">
                    {JSON.stringify(cell.handoff.payload ?? {}, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
