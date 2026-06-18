"use client";

import { type CSSProperties, useEffect, useRef, type ReactNode } from "react";
import { Icon } from "@/design/icons/icon";

export interface SlideOverProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  /** Drawer width. A number is treated as pixels; a string is used verbatim as
      a CSS length (e.g. `clamp(560px, 60vw, 1024px)` for a responsive drawer). */
  width?: number | string;
  /** Fit the body to the drawer instead of the default scrolling/padded body.
      When `true` the body is a bounded `flex` column with no scroll + no padding
      so the child owns its own single internal scroll region and bottom bar
      (e.g. ChatScreen — avoids a nested double-scroll, ISS-506). Default `false`
      preserves every existing consumer (RunDetail, project flyout, …). */
  fitBody?: boolean;
}

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';

/** Right-hand drawer — context/detail (e.g. RunDetail) opens here rather than
    navigating away. Esc to close, focus trapped inside, focus returns to the
    trigger on close. Backdrop blur signals background dismissal. */
export function SlideOver({ open, onClose, title, children, width = 480, fitBody = false }: SlideOverProps) {
  const slideOverWidth = typeof width === "number" ? `${width}px` : width;
  const panelRef = useRef<HTMLElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "Tab" && panel) {
        const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
          (n) => n.offsetParent !== null,
        );
        if (nodes.length === 0) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      restoreRef.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      style={{ background: "rgba(24,27,34,0.25)", backdropFilter: "blur(8px)" }}
      onClick={onClose}
    >
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        className="forge-slide flex h-full w-full max-w-[100vw] flex-col border-l border-line bg-surface shadow-lg sm:w-[var(--slide-over-w)]"
        style={{ "--slide-over-w": slideOverWidth } as CSSProperties}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex flex-none items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div className="fg-h3">{title}</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-subtle transition-colors hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
          >
            <Icon name="x" size={18} />
          </button>
        </header>
        {fitBody ? (
          <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        ) : (
          <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        )}
      </aside>
    </div>
  );
}
