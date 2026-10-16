import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

export interface EmptyPanelLineProps {
  title: string;
  status: string;
  /** Yields first: from sm up it truncates, with its full wording as the hover text; below sm, where
   *  there is no hover, it wraps onto a row of its own. */
  detail?: string;
  className?: string;
  action?: ReactNode;
}

/** A secondary panel with nothing in it is one line from sm up, never a second. */
export function EmptyPanelLine({ title, status, detail, className, action }: EmptyPanelLineProps) {
  return (
    <section
      aria-label={title}
      className={cn(
        "flex min-h-10 min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-line bg-surface px-3 py-2 shadow-sm sm:h-10 sm:flex-nowrap sm:py-0",
        className,
      )}
    >
      <h3 className="fg-label shrink-0 whitespace-nowrap">{title}</h3>
      <span aria-hidden className="shrink-0 text-subtle">·</span>
      <span className="fg-caption shrink-0 whitespace-nowrap text-muted">{status}</span>
      {detail ? (
        <>
          <span aria-hidden className="hidden shrink-0 text-subtle sm:inline">·</span>
          <span
            className="fg-caption min-w-0 basis-full break-words text-muted sm:flex-1 sm:basis-auto sm:truncate"
            title={detail}
          >
            {detail}
          </span>
        </>
      ) : (
        <span className="flex-1" />
      )}
      {action ? <span className="shrink-0">{action}</span> : null}
    </section>
  );
}
