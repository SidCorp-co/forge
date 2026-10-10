"use client";

// Flush rows for anything that is not an entity standing somewhere (GroupedList draws those): tokens,
// members, connections, runs, files. One row is a lead (a key, a mark), a title with one facts line
// under it, and its trailing state and acts; rows are ruled by hairlines, never boxed. A row with
// `href` is a link, one with `onClick` a button, else plain.

import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { keyedNodes } from "../keyed";

export function RowList({ children, label, header, testId, className }: { children: ReactNode; label?: string; header?: ReactNode; testId?: string; className?: string }) {
  return (
    <div className={cn("border-t border-line-subtle", className)} data-testid={testId ?? "row-list"}>
      {header ? <div className="flex items-center gap-3 border-b border-line-subtle bg-sunken px-3 py-1.5 text-11-5 font-semibold text-subtle">{header}</div> : null}
      <ul aria-label={label}>{children}</ul>
    </div>
  );
}

export interface RowItemProps {
  title: ReactNode;
  lead?: ReactNode;
  /** The one secondary line under the title; parts are joined by a middle dot. */
  facts?: ReactNode[];
  /** A line under the facts that wraps instead of being cut. */
  note?: ReactNode;
  /** State, counts and acts at the row's right; they wrap under the title at phone width. */
  trailing?: ReactNode;
  href?: string;
  /** With `href`, runs as the link is followed; without it, the row is a button. */
  onClick?: () => void;
  selected?: boolean;
  dim?: boolean;
  testId?: string;
  /** Whatever opens under the row in place (an editor, a confirm step). */
  children?: ReactNode;
}

function Facts({ facts }: { facts: ReactNode[] }) {
  return (
    <span className="block min-w-0 truncate text-12 text-subtle" data-testid="row-facts">
      {keyedNodes(facts).map(({ key, item: p, index: i }) => (
        <span key={key} className="whitespace-nowrap">
          {i > 0 ? <span className="mx-1.5 text-neutral-8">·</span> : null}
          {p}
        </span>
      ))}
    </span>
  );
}

export function RowItem({ title, lead, facts, note, trailing, href, onClick, selected, dim, testId, children }: RowItemProps) {
  const body = (
    <>
      {lead ? <span className="flex flex-none items-center font-mono text-11-5 font-semibold text-link">{lead}</span> : null}
      <span className={cn("flex min-w-0 flex-1 flex-col", dim && "opacity-65")}>
        <span className="min-w-0 truncate text-13-5 font-medium text-fg">{title}</span>
        {facts?.length ? <Facts facts={facts} /> : null}
        {note ? <span className="mt-0.5 block text-12 text-muted">{note}</span> : null}
      </span>
      {trailing ? <span className="flex min-w-0 flex-wrap items-center justify-end gap-2 max-md:basis-full max-md:justify-start">{trailing}</span> : null}
    </>
  );
  const row = cn(
    "flex min-h-12 w-full flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 text-left no-underline md:flex-nowrap",
    (href || onClick) && "cursor-pointer hover:bg-hover",
    selected && "bg-sel",
  );
  return (
    <li className="border-b border-line-subtle" data-testid={testId ?? "row-item"} aria-current={selected || undefined}>
      {href ? (
        <Link href={href} onClick={onClick} className={row}>
          {body}
        </Link>
      ) : onClick ? (
        <button type="button" onClick={onClick} className={row}>
          {body}
        </button>
      ) : (
        <div className={row}>{body}</div>
      )}
      {children ? <div className="px-3 pb-3">{children}</div> : null}
    </li>
  );
}
