import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils/cn";

export function rampOr(step: string, className?: string) {
  return /\bfg-h[1-4]\b/.test(className ?? "") ? className : cn(step, className);
}

/** The page's one h1; `heads={false}` keeps the look where a state filling the page is the h1 instead. */
export function PageTitle({
  className,
  heads = true,
  ...props
}: HTMLAttributes<HTMLHeadingElement> & { heads?: boolean }) {
  const Tag = heads ? "h1" : "p";
  return <Tag className={rampOr("fg-h1", className)} {...props} />;
}

/** A section heading under the page title — an h2, one step below it. */
export function SectionTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={rampOr("fg-h2", className)} {...props} />;
}
