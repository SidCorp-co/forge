import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils/cn";
import { Tooltip } from "./tooltip";

export function rampOr(step: string, className?: string) {
  return /\bfg-h[1-4]\b/.test(className ?? "") ? className : cn(step, className);
}

export interface PageTitleProps extends HTMLAttributes<HTMLHeadingElement> {
  /** What the page is for, shown on hovering the title. */
  hint?: string;
}

// cm:why a page carries no subtitle line under its title (ISS-49): what the page is for rides the title's tooltip, and the heading's accessible description
export function PageTitle({ className, hint, children, ...props }: PageTitleProps) {
  if (!hint) {
    return (
      <h1 className={rampOr("fg-h1", className)} {...props}>
        {children}
      </h1>
    );
  }
  return (
    <h1 className={rampOr("fg-h1", className)} aria-description={hint} {...props}>
      <Tooltip label={hint} side="bottom" multiline>
        <span className="cursor-help">{children}</span>
      </Tooltip>
    </h1>
  );
}

/** A section heading under the page title — an h2, one step below it. */
export function SectionTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={rampOr("fg-h2", className)} {...props} />;
}
