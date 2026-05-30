import { cn } from "@/lib/utils/cn";

type Tone = "accent" | "green" | "red" | "cobalt";

const TONE: Record<Tone, string> = {
  accent: "var(--accent)",
  green: "var(--green-500)",
  red: "var(--red-500)",
  cobalt: "var(--cobalt-500)",
};

export interface ProgressBarProps {
  /** 0–100. Ignored when `indeterminate`. */
  value?: number;
  indeterminate?: boolean;
  tone?: Tone;
  className?: string;
}

export function ProgressBar({ value = 0, indeterminate, tone = "accent", className }: ProgressBarProps) {
  const color = TONE[tone];
  return (
    <div
      className={cn("relative h-1 w-full overflow-hidden rounded-pill bg-[var(--paper-200)]", className)}
      role="progressbar"
      aria-valuenow={indeterminate ? undefined : value}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      {indeterminate ? (
        <span className="forge-indeterminate" style={{ background: color }} />
      ) : (
        <span
          className="block h-full rounded-pill transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
          style={{ width: `${Math.min(100, Math.max(0, value))}%`, background: color }}
        />
      )}
    </div>
  );
}
