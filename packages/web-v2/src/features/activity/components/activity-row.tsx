"use client";

// One timeline row: stage-hued rail + icon, verb + detail, project chip + time.
// Wrapped in Highlight so a row that arrives over WS flashes once.
import { Highlight, Icon, MonoTag, type IconName } from "@/design";
import { detailLine, eventColor, eventIcon, relativeTime, verbLabel } from "../derive";
import type { FeedRow } from "../types";

export function ActivityRow({ row, now }: { row: FeedRow; now: number }) {
  const color = eventColor(row);
  const detail = detailLine(row);

  return (
    <Highlight trigger={row.id}>
      <div className="flex items-start gap-3 py-3">
        {/* Stage-hued rail + icon */}
        <span
          className="mt-0.5 inline-flex size-7 flex-none items-center justify-center rounded-md"
          style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color }}
        >
          <Icon name={eventIcon(row) as IconName} size={15} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="fg-body-sm font-semibold text-fg">{verbLabel(row)}</span>
            {detail && <span className="fg-body-sm text-muted">· {detail}</span>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <MonoTag hue="cobalt">{row.projectName}</MonoTag>
            <span className="fg-caption">{row.actorType}</span>
          </div>
        </div>

        <span className="fg-caption flex-none whitespace-nowrap font-mono">
          {relativeTime(row.createdAt, now)}
        </span>
      </div>
    </Highlight>
  );
}
