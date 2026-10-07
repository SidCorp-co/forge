"use client";

import { HEALTH_MARKER_KINDS, type HealthMarkerKind, type WorkflowHealthSummary } from "@forge/contracts/workflow-health";
import { Tooltip } from "@/design";
import { useCopy, useLabel } from "@/lib/i18n/interface-language";
import { HEALTH_HUE } from "../canvas/style";

/** One marker kind as a dot (zoomed out) or a chip with its label (full card, rail, list); snake_case only in the tooltip. */
export function HealthMark({ kind, count, dot = false, title }: { kind: HealthMarkerKind; count?: number; dot?: boolean; title?: string }) {
  const label = useLabel();
  const word = label("healthMarker", kind);
  const tip = title ?? `${kind} · ${word}`;
  if (dot) {
    return <span role="img" aria-label={word} title={tip} className="inline-block size-2 flex-none rounded-full" style={{ background: HEALTH_HUE[kind] }} data-testid="health-dot" data-kind={kind} />;
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
      <span className="truncate">{word}</span>
      {count !== undefined ? <span className="font-mono tabular-nums">{count}</span> : null}
    </span>
  );
}

/** A design's marker counts on the workflows list: a chip per kind it carries and its needs-you count; nothing when it carries none (REQ-17 BC-18). */
export function HealthSummaryChips({ health }: { health: WorkflowHealthSummary | undefined }) {
  const t = useCopy();
  const label = useLabel();
  if (!health) return null;
  const kinds = HEALTH_MARKER_KINDS.filter((k) => health.counts[k] > 0);
  if (kinds.length === 0 && health.needsYou === 0) return null;
  const scope = health.workflowLevelOnly ? t("workflows.health.workflowLevel") : t("workflows.health.onSteps");
  return (
    <Tooltip label={`${scope}${health.needsYou ? ` · ${t("workflows.health.needPerson", { n: health.needsYou })}` : ""}`} side="bottom" multiline>
      <span className="flex min-w-0 flex-wrap items-center gap-1" data-testid="health-summary" data-workflow-level={health.workflowLevelOnly || undefined}>
        {kinds.map((k) => (
          <HealthMark key={k} kind={k} count={health.counts[k]} title={`${k} · ${label("healthMarker", k)} ${health.counts[k]}`} />
        ))}
        {health.needsYou > 0 ? (
          <span className="whitespace-nowrap text-11-5 font-semibold text-accent-text" data-testid="health-needs-you">
            {t("workflows.health.needsYou", { n: health.needsYou })}
          </span>
        ) : null}
      </span>
    </Tooltip>
  );
}
