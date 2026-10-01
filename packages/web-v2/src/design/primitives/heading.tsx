"use client";

import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils/cn";
import { Tooltip } from "./tooltip";
import { useInTopBar, useTopBarPortal } from "./top-bar-slot";

export function rampOr(step: string, className?: string) {
  return /\bfg-h[1-4]\b/.test(className ?? "") ? className : cn(step, className);
}

export interface PageTitleProps extends HTMLAttributes<HTMLHeadingElement> {
  /** What the page is for, shown on hovering the title. */
  hint?: string;
}

// cm:why a page carries no subtitle line under its title (ISS-49): what the page is for rides the title's tooltip, and the heading's accessible description
// cm:why inside the workspace shell the title renders into the top bar in the bar's own type, so a page's className only shapes it where there is no bar
export function PageTitle({ className, hint, children, ...props }: PageTitleProps) {
  const inBar = useInTopBar();
  const cls = inBar ? "fg-h3 min-w-0 truncate" : rampOr("fg-h1", className);
  const heading = (
    <h1 className={cls} aria-description={hint} title={inBar && typeof children === "string" ? children : undefined} {...props}>
      {hint ? (
        <Tooltip label={hint} side="bottom" multiline>
          <span className="cursor-help">{children}</span>
        </Tooltip>
      ) : (
        children
      )}
    </h1>
  );
  return <>{useTopBarPortal("title", heading)}</>;
}

/** A section heading under the page title — an h2, one step below it. */
export function SectionTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={rampOr("fg-h2", className)} {...props} />;
}
