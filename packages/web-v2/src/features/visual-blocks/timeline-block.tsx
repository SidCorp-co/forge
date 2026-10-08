"use client";

import type { VisualBlockOf } from "@forge/contracts/visual-blocks";
import { share, type TimelineItem, timelineModel } from "./timeline-model";
import { TextAlternative } from "./text-alternative";

const PLAN = "var(--chart-2)";
const FORECAST = "var(--chart-1)";
const pct = (x: number) => `${(x * 100).toFixed(3)}%`;

function Marks({ item, axis }: { item: TimelineItem; axis: { min: number; max: number } }) {
  const { span, forecast } = item;
  return (
    <>
      {span && (
        <span
          className="absolute top-1/2 h-2 min-w-[3px] -translate-y-1/2 rounded-[2px]"
          data-testid="timeline-span"
          title={span.toText ? `${span.fromText} to ${span.toText}` : span.fromText}
          style={{
            left: pct(share(axis, span.from)),
            width: pct(share(axis, span.to) - share(axis, span.from)),
            background: PLAN,
          }}
        />
      )}
      {forecast && (
        <>
          <span
            className="absolute top-1/2 h-0 border-t-2 border-dashed"
            data-testid="timeline-forecast"
            title={`p50 ${forecast.p50Text}, p85 ${forecast.p85Text}`}
            style={{
              left: pct(share(axis, forecast.p50)),
              width: pct(share(axis, forecast.p85) - share(axis, forecast.p50)),
              borderColor: FORECAST,
            }}
          />
          <span
            className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{ left: pct(share(axis, forecast.p50)), background: FORECAST }}
          />
          <span
            className="absolute top-1/2 h-3 w-0 -translate-x-1/2 -translate-y-1/2 border-l-2"
            style={{ left: pct(share(axis, forecast.p85)), borderColor: FORECAST }}
          />
        </>
      )}
    </>
  );
}

/** A timeline block: each item a row on one linear time axis that runs exactly from the earliest date the frame holds to the latest. */
export function TimelineBlockView({ block }: { block: VisualBlockOf<"timeline"> }) {
  const m = timelineModel(block);
  return (
    <div data-testid="timeline-block">
      {(m.hasSpan || m.hasForecast) && (
        <ul className="m-0 mb-1 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[11.5px] text-muted" data-testid="timeline-legend">
          {m.hasSpan && (
            <li className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-2 w-3 rounded-[2px]" style={{ background: PLAN }} />
              Planned
            </li>
          )}
          {m.hasForecast && (
            <li className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block w-3 border-t-2 border-dashed" style={{ borderColor: FORECAST }} />
              Forecast, p50 to p85
            </li>
          )}
        </ul>
      )}
      <div aria-hidden className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] text-[12.5px]">
        {m.items.map((item, i) => (
          // two items may share a label; position is their identity
          // biome-ignore lint/suspicious/noArrayIndexKey: items are positional
          <div key={i} className="contents" data-testid="timeline-item">
            {item.lane !== null && item.lane !== m.items[i - 1]?.lane && (
              <div className="col-span-2 mt-2 text-[11.5px] font-semibold text-subtle first:mt-0">{item.lane}</div>
            )}
            <div className="truncate border-b border-line-subtle py-1.5 pr-3 text-fg" title={item.label}>
              {item.label}
            </div>
            <div className="relative h-7 border-b border-line-subtle">
              <Marks item={item} axis={m} />
            </div>
          </div>
        ))}
        {m.items.length > 0 && (
          <>
            <div />
            <div className="flex justify-between pt-1 font-mono text-[11px] tabular-nums text-subtle" data-testid="timeline-axis">
              <span>{m.minText}</span>
              {m.maxText !== m.minText && <span>{m.maxText}</span>}
            </div>
          </>
        )}
      </div>
      {m.undated.length > 0 && (
        <p className="mt-1.5 text-[11.5px] text-subtle" data-testid="timeline-undated">
          No date in the data for: {m.undated.join(", ")}.
        </p>
      )}
      <TextAlternative block={block} />
    </div>
  );
}
