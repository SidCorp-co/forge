import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils/cn";
import { rampOr } from "./heading";

/** A flush section of a page: no frame, no fill, no shadow. Its heading and the
    whitespace around it are what set it off from its neighbours. */
export function PageSection({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("min-w-0", className)} {...props} />;
}

/** The section's heading row, ruled off from its body by one hairline. */
export function PageSectionHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex items-center justify-between gap-3 border-b border-line-subtle py-3", className)}
      {...props}
    />
  );
}

/** An h3, one step below `SectionTitle`. */
export function PageSectionTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={rampOr("fg-h3", className)} {...props} />;
}

export function PageSectionBody({ className, style, ...props }: HTMLAttributes<HTMLDivElement>) {
  // Vertical padding follows the global density var; compact mode tightens it.
  return (
    <div
      className={className}
      style={{ paddingTop: "var(--density-card-py)", paddingBottom: "var(--density-card-py)", ...style }}
      {...props}
    />
  );
}
