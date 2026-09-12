import { cn } from "@/lib/utils/cn";

export interface DotStripItem {
  key: string;
  /** Drives the dot's position along the strip. */
  value: number;
  label: string;
  /** Where this record is shown. Absent → drawn without a door. */
  onOpen?: () => void;
}

export interface DotStripProps {
  items: DotStripItem[];
  /** Ticks under the axis, low → high. */
  axisLabels?: [string, string];
  className?: string;
}

/**
 * One dot per record, placed by age.
 */
// cm:guard one dot per item and never a bucketed histogram: the question this answers is "how old is the oldest one", and a count-per-bin drops the single 103-day outlier that is the whole reason to look (ISS-988 criterion 31).
export function DotStrip({ items, axisLabels, className }: DotStripProps) {
  if (items.length === 0) return null;

  const max = Math.max(...items.map((i) => i.value), 1);

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="relative h-6 w-full rounded-sm bg-sunken">
        {items.map((item) => {
          const left = `${((item.value / max) * 100).toFixed(2)}%`;
          const style = { left, transform: "translate(-50%, -50%)" } as const;
          return item.onOpen ? (
            <button
              key={item.key}
              type="button"
              onClick={item.onOpen}
              aria-label={item.label}
              style={style}
              className="absolute top-1/2 size-2.5 rounded-full bg-accent opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
            />
          ) : (
            <span
              key={item.key}
              aria-hidden
              style={style}
              className="absolute top-1/2 size-2.5 rounded-full bg-disabled opacity-70"
            />
          );
        })}
      </div>
      {axisLabels ? (
        <div className="flex justify-between">
          <span className="fg-body-sm text-subtle">{axisLabels[0]}</span>
          <span className="fg-body-sm text-subtle">{axisLabels[1]}</span>
        </div>
      ) : null}
    </div>
  );
}
