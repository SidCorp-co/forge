import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

export interface EmptyPanelLineProps {
  title: string;
  status: string;
  /** Yields first: truncates, with its full wording as the hover text. */
  detail?: string;
  className?: string;
  action?: ReactNode;
}

/** A secondary panel with nothing in it is one line, never a second. */
export function EmptyPanelLine({ title, status, detail, className, action }: EmptyPanelLineProps) {
  return (
    <section
      aria-label={title}
      className={cn(
        "flex h-10 min-w-0 items-center gap-2 rounded-lg border border-line bg-surface px-3 shadow-sm",
        className,
      )}
    >
      <h3 className="fg-label shrink-0 whitespace-nowrap">{title}</h3>
      <span aria-hidden className="shrink-0 text-subtle">·</span>
      <span className="fg-caption shrink-0 whitespace-nowrap text-muted">{status}</span>
      {detail ? (
        <>
          <span aria-hidden className="shrink-0 text-subtle">·</span>
          <span className="fg-caption min-w-0 flex-1 truncate text-muted" title={detail}>
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
