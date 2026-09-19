"use client";


import { useState } from "react";
import { Icon } from "@/design";
import { stageColor } from "@/design/stages";
import type { StepOutcome, StepState } from "../derive";

interface StepArtifactCardProps {
  outcome: StepOutcome;
  open: boolean;
  onToggle: () => void;
}

const STATE_META: Record<StepState, { dot: string; label: string }> = {
  done: { dot: "var(--green-500)", label: "Done" },
  running: { dot: "var(--pipeline-active)", label: "Running" },
  failed: { dot: "var(--red-500)", label: "Failed" },
};

const SKIP_KEYS = new Set(["step", "schema_version", "schemaVersion"]);

function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

const ARRAY_TEXT_KEYS = ["path", "file", "title", "name", "test", "what", "step"];

type ArtifactListItem = { key: string; text: string };

function toListItems(value: unknown): ArtifactListItem[] {
  if (!Array.isArray(value)) return [];

  const counts = new Map<string, number>();
  const items: ArtifactListItem[] = [];
  for (const valueItem of value) {
    let text: string;
    if (typeof valueItem === "string") {
      text = valueItem;
    } else if (valueItem && typeof valueItem === "object") {
      const objectItem = valueItem as Record<string, unknown>;
      const key = ARRAY_TEXT_KEYS.find((candidate) => typeof objectItem[candidate] === "string");
      try {
        text = key ? String(objectItem[key]) : (JSON.stringify(valueItem) ?? String(valueItem));
      } catch {
        text = String(valueItem);
      }
    } else {
      text = String(valueItem);
    }
    if (!text.trim()) continue;

    const count = counts.get(text) ?? 0;
    counts.set(text, count + 1);
    items.push({ key: `${text}-${count}`, text });
  }
  return items;
}

export function StepArtifactCard({ outcome, open, onToggle }: StepArtifactCardProps) {
  const [showRaw, setShowRaw] = useState(false);
  const meta = STATE_META[outcome.state];
  const payload = outcome.handoff?.payload ?? null;

  // Partition payload into string paragraphs vs string-array lists for the body.
  const paragraphs: { key: string; text: string }[] = [];
  const lists: { key: string; items: ArtifactListItem[] }[] = [];
  if (payload && typeof payload === "object") {
    for (const [key, value] of Object.entries(payload)) {
      if (SKIP_KEYS.has(key)) continue;
      if (typeof value === "string" && value.trim()) {
        paragraphs.push({ key, text: value.trim() });
      } else if (Array.isArray(value)) {
        const items = toListItems(value);
        if (items.length) lists.push({ key, items });
      }
    }
  }
  const hasBody = paragraphs.length > 0 || lists.length > 0;

  return (
    <div
      id={`step-card-${outcome.step}`}
      className="rounded-lg border border-line-subtle bg-surface scroll-mt-24"
      style={open ? { borderColor: "var(--accent)" } : undefined}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-x-2.5 gap-y-1 px-3 py-2.5 text-left"
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
        <span
          aria-hidden
          className="inline-block size-2 flex-none rounded-full"
          style={{ background: meta.dot }}
        />
        <span
          aria-hidden
          className="inline-block h-3 w-0.5 flex-none rounded-pill"
          style={{ background: stageColor(outcome.step) }}
        />
        <span className="fg-label min-w-0 truncate font-mono">{outcome.step}</span>
        <span className="fg-caption text-muted">{meta.label}</span>
        <span className="ml-auto flex flex-none items-center gap-3">
          {outcome.durationSeconds != null && (
            <span className="fg-caption inline-flex items-center gap-1 text-muted">
              <Icon name="clock" size={12} />
              {fmtDuration(outcome.durationSeconds)}
            </span>
          )}
          <span className="fg-caption inline-flex items-center gap-0.5 text-muted">
            <Icon name="dollar" size={12} />
            {outcome.costUsd != null ? outcome.costUsd.toFixed(2) : "—"}
          </span>
        </span>
      </button>

      {open && (
        <div className="forge-fade space-y-3 border-t border-line-subtle px-3 py-3">
          {!outcome.handoff && !hasBody && (
            <p className="fg-body-sm text-muted">This step recorded no handoff.</p>
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
                {l.items.map((item) => (
                  <li key={`${l.key}-${item.key}`} className="break-words">
                    {item.text}
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {outcome.handoff && (
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
                    attempt {outcome.handoff.attempt}
                    {outcome.handoff.pipelineRunId ? ` · run ${outcome.handoff.pipelineRunId}` : ""}
                  </p>
                  <pre className="max-h-72 overflow-auto rounded-md bg-app/60 p-2 text-11 leading-snug">
                    {JSON.stringify(outcome.handoff.payload ?? {}, null, 2)}
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
