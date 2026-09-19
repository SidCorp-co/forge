import { cn } from "@/lib/utils/cn";

export interface BulletBarProps {
  label: string;
  /** The measured part. */
  value: number;
  /** What `value` is a part of. Zero renders the bar empty, never NaN. */
  total: number;
  /** Overridden where the pair is not a percentage (a ratio, a count). */
  valueText?: string;
  color?: string;
  className?: string;
}

/**
 * A rate drawn against the whole it is a part of.
 */
export function BulletBar({
  label,
  value,
  total,
  valueText,
  color = "var(--accent)",
  className,
}: BulletBarProps) {
  const share = total > 0 ? value / total : 0;
  const text = valueText ?? `${value} of ${total}`;

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="fg-body-sm text-muted">{label}</span>
        <span className="fg-body-sm tabular-nums">{text}</span>
      </div>
      <div
        aria-hidden
        className="h-1.5 w-full overflow-hidden rounded-full bg-sunken"
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${(share * 100).toFixed(2)}%`, background: color }}
        />
      </div>
    </div>
  );
}
