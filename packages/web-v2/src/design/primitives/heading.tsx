
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { useInTopBar, useTopBarPortal } from "./top-bar-slot";

export function rampOr(step: string, className?: string) {
  return /\bfg-h[1-4]\b/.test(className ?? "") ? className : cn(step, className);
}

interface PageTitleProps extends HTMLAttributes<HTMLHeadingElement> {
  back?: ReactNode;
  /** What names the record beside its title — its key, its state — after the heading. */
  after?: ReactNode;
}

// a page carries no subtitle line under its title (ISS-49) and no tooltip saying what it is for (REQ-43 BC-4): the title names it
// inside the workspace shell the title renders into the top bar in the bar's own type, so a page's className only shapes it where there is no bar
export function PageTitle({ className, back, after, children, ...props }: PageTitleProps) {
  const inBar = useInTopBar();
  // in the bar the title takes the room the bar's acts and what follows it leave, and wraps to a second line past
  // that, never running under them (ISS-1072); what follows it (its state, its views) stays whole up to half the bar
  const cls = inBar ? "fg-h3 min-w-0 line-clamp-2 break-words leading-tight" : rampOr("fg-h1", className);
  const heading = (
    <h1 className={cls} title={inBar && typeof children === "string" ? children : undefined} {...props}>
      {children}
    </h1>
  );
  return (
    <>
      {useTopBarPortal(
        "title",
        back || after ? (
          <>
            {back}
            {heading}
            {after != null ? <span className="min-w-0 max-w-1/2 flex-none truncate">{after}</span> : null}
          </>
        ) : (
          heading
        ),
      )}
    </>
  );
}

/** A section heading under the page title — an h2, one step below it. */
export function SectionTitle({ className, children, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2 className={rampOr("fg-h2", className)} {...props}>
      {children}
    </h2>
  );
}
