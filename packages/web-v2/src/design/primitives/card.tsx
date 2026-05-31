import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils/cn";

/** White surface, 1px warm border, soft low shadow — rests on the paper bg. */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-lg border border-line bg-surface shadow-sm", className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex items-center justify-between gap-3 border-b border-line-subtle px-5 py-4", className)}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("fg-h3", className)} {...props} />;
}

export function CardContent({ className, style, ...props }: HTMLAttributes<HTMLDivElement>) {
  // Vertical padding follows the global density var; compact mode tightens it.
  return (
    <div
      className={cn("px-5", className)}
      style={{ paddingTop: "var(--density-card-py)", paddingBottom: "var(--density-card-py)", ...style }}
      {...props}
    />
  );
}
