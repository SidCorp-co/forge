// A list whose rows open in place (REQ-11 BC-22): each row is one line, and its detail opens under
// it on a click or Enter, so a fact a person does not need now is never on the face. j and k (or the
// arrows) move between rows, Enter or Space opens and shuts the one in focus, Escape shuts it. One
// row is open at a time. A row's detail is not drawn while it is shut.

import { createContext, type KeyboardEvent, type ReactNode, use, useId, useState } from "react";
import { cn } from "@/lib/utils/cn";
import { Icon } from "../icons/icon";

interface ExpandState {
  open: string | null;
  toggle: (id: string) => void;
  close: () => void;
}

const ExpandContext = createContext<ExpandState | null>(null);

interface ExpandRowsProps {
  /** What the list holds, for a screen reader: "Runs". */
  label: string;
  children: ReactNode;
  /** The row open on the first draw. */
  defaultOpen?: string | null;
  onOpenChange?: (id: string | null) => void;
  className?: string;
  testId?: string;
}

/** A list with no rows draws its own empty line in place of this: a list never stands open and blank. */
export function ExpandRows({ label, children, defaultOpen = null, onOpenChange, className, testId }: ExpandRowsProps) {
  const [open, setOpen] = useState<string | null>(defaultOpen);
  const change = (next: string | null) => {
    setOpen(next);
    onOpenChange?.(next);
  };
  return (
    <ExpandContext value={{ open, toggle: (id) => change(open === id ? null : id), close: () => change(null) }}>
      <div role="list" aria-label={label} data-expand-rows="" data-testid={testId} className={cn("min-w-0", className)}>
        {children}
      </div>
    </ExpandContext>
  );
}

const MOVE: Record<string, 1 | -1> = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 };

/** j/k and the arrows move focus to the next or previous row of the same list; Escape shuts the open one. */
function onHeadKey(e: KeyboardEvent<HTMLButtonElement>, ctx: ExpandState) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const step = MOVE[e.key];
  if (step) {
    const list = e.currentTarget.closest("[data-expand-rows]");
    const heads = [...(list?.querySelectorAll<HTMLElement>("[data-expand-head]") ?? [])].filter((h) => h.closest("[data-expand-rows]") === list);
    e.preventDefault();
    heads[Math.max(0, Math.min(heads.length - 1, heads.indexOf(e.currentTarget) + step))]?.focus();
  } else if (e.key === "Escape" && ctx.open !== null) {
    e.preventDefault();
    ctx.close();
  }
}

interface ExpandRowProps {
  id: string;
  /** The row's one line: a name, a status chip, at most a short fact. */
  head: ReactNode;
  /** Acts beside the line (Approve, Decline), outside the toggle so a click on one never opens the row. */
  trail?: ReactNode;
  /** What opens under the line. */
  children: ReactNode;
  className?: string;
  testId?: string;
}

export function ExpandRow({ id, head, trail, children, className, testId }: ExpandRowProps) {
  const ctx = use(ExpandContext);
  if (!ctx) throw new Error("ExpandRow is drawn outside ExpandRows: a row opens in a list that moves focus between its rows.");
  const detailId = useId();
  const isOpen = ctx.open === id;
  return (
    <div role="listitem" data-expand-row={id} data-open={isOpen ? "" : undefined} data-testid={testId} className={cn("border-b border-line-divider", className)}>
      <div className="flex min-h-row min-w-0 items-center">
        <button
          type="button"
          data-expand-head=""
          aria-expanded={isOpen}
          aria-controls={isOpen ? detailId : undefined}
          onClick={() => ctx.toggle(id)}
          onKeyDown={(e) => onHeadKey(e, ctx)}
          className="group/head flex min-h-row min-w-0 flex-1 items-center gap-2 px-5 text-left text-14 text-fg hover:bg-hover focus-visible:outline-none focus-visible:shadow-focus"
        >
          <Icon name="chevronRight" size={14} className={cn("flex-none text-subtle transition-transform duration-150", isOpen && "rotate-90")} />
          <span className="flex min-w-0 flex-1 items-center gap-3">{head}</span>
        </button>
        {trail ? <div className="flex flex-none items-center gap-1.5 pr-5">{trail}</div> : null}
      </div>
      {isOpen ? (
        <div id={detailId} data-expand-detail="" className="min-w-0 pb-4 pl-11 pr-5 text-13 text-muted">
          {children}
        </div>
      ) : null}
    </div>
  );
}
