
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
  // beside its key or count the title keeps its whole name, up to the whole bar, and what follows it gives way first
  const cls = inBar ? cn("fg-h3 min-w-0 truncate", after != null && "max-w-full shrink-0") : rampOr("fg-h1", className);
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
            {after != null ? <span className="min-w-0 truncate">{after}</span> : null}
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
