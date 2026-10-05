"use client";

import { HEALTH_MARKER_KINDS, HEALTH_MARKER_LABELS, type HealthMarkerKind, type WorkflowHealthSummary } from "@forge/contracts/workflow-health";
import { Tooltip } from "@/design";
import { HEALTH_HUE } from "../canvas/style";

/** One marker kind as a dot (zoomed out) or a chip with its label (full card, rail, list); snake_case only in the tooltip. */
export function HealthMark({ kind, count, dot = false, title }: { kind: HealthMarkerKind; count?: number; dot?: boolean; title?: string }) {
  const tip = title ?? `${kind} · ${HEALTH_MARKER_LABELS[kind]}`;
  if (dot) {
    return <span role="img" aria-label={HEALTH_MARKER_LABELS[kind]} title={tip} className="inline-block size-2 flex-none rounded-full" style={{ background: HEALTH_HUE[kind] }} data-testid="health-dot" data-kind={kind} />;
  }
  return (
    <span
      className="inline-flex max-w-full cursor-default items-center gap-1.5 whitespace-nowrap rounded-pill px-2 py-[2px] text-11-5 font-semibold text-fg"
      style={{ background: `color-mix(in srgb, ${HEALTH_HUE[kind]} 16%, var(--bg-surface))` }}
      title={tip}
      data-testid="health-chip"
      data-kind={kind}
    >
      <span aria-hidden className="size-1.5 flex-none rounded-full" style={{ background: HEALTH_HUE[kind] }} />
      <span className="truncate">{HEALTH_MARKER_LABELS[kind]}</span>
      {count !== undefined ? <span className="font-mono tabular-nums">{count}</span> : null}
    </span>
  );
}

/** A design's marker counts on the workflows list: a chip per kind it carries and its needs-you count; nothing when it carries none (REQ-17 BC-18). */
export function HealthSummaryChips({ health }: { health: WorkflowHealthSummary | undefined }) {
  if (!health) return null;
  const kinds = HEALTH_MARKER_KINDS.filter((k) => health.counts[k] > 0);
  if (kinds.length === 0 && health.needsYou === 0) return null;
  const scope = health.workflowLevelOnly ? "Workflow-level: the records behind these markers name no step yet" : "Markers on this design's steps and lines";
  return (
    <Tooltip label={`${scope}${health.needsYou ? ` · ${health.needsYou} need a person` : ""}`} side="bottom" multiline>
      <span className="flex min-w-0 flex-wrap items-center gap-1" data-testid="health-summary" data-workflow-level={health.workflowLevelOnly || undefined}>
        {kinds.map((k) => (
          <HealthMark key={k} kind={k} count={health.counts[k]} title={`${k} · ${HEALTH_MARKER_LABELS[k]} ${health.counts[k]}`} />
        ))}
        {health.needsYou > 0 ? (
          <span className="whitespace-nowrap text-11-5 font-semibold text-accent-text" data-testid="health-needs-you">
            Needs you {health.needsYou}
          </span>
        ) : null}
      </span>
    </Tooltip>
  );
}
