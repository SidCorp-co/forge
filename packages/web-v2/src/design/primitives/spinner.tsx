import { cn } from "@/lib/utils/cn";

export interface SpinnerProps {
  size?: number;
  className?: string;
}

export function Spinner({ size = 16, className }: SpinnerProps) {
  return (
    <span
      className={cn("inline-block animate-spin rounded-pill border-2 border-line-strong border-t-accent", className)}
      style={{ width: size, height: size }}
      role="status"
      aria-label="Loading"
    />
  );
}
