"use client";

import { type CSSProperties, createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
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
  /** Skip the drawer's own title bar (opt-in, default `false` — every existing
      caller keeps its header). Use when the child renders its own single title
      + close control, to avoid a duplicate title bar (e.g. the mobile chat
      overlay stacking on ChatScreen's header, ISS-685). */
  hideHeader?: boolean;
}

interface Layer {
  parent: Layer | null;
}

const SlideOverLayer = createContext<Layer | null>(null);

/** The open slide-overs, topmost last: only that one answers Escape and holds Tab, so a
 *  confirmation opened over a drawer closes alone (ISS-1339 r3). */
const openStack: Layer[] = [];

function isWithin(layer: Layer, ancestor: Layer): boolean {
  for (let p = layer.parent; p; p = p.parent) if (p === ancestor) return true;
  return false;
}

/** Opened last is on top, but a nested one is above its parent, whose later effect leaves it focus. */
function stack(layer: Layer): void {
  const below = openStack.findIndex((open) => isWithin(open, layer));
  if (below === -1) openStack.push(layer);
  else openStack.splice(below, 0, layer);
}

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';

/** Right-hand drawer for context/detail. Esc closes it unless a control inside
    claimed the key first; focus is trapped inside and returns to the trigger on
    close. Backdrop blur signals background dismissal. */
export function SlideOver({
  open,
  onClose,
  title,
  children,
  width = 480,
  fitBody = false,
  hideHeader = false,
}: SlideOverProps) {
  const slideOverWidth = typeof width === "number" ? `${width}px` : width;
  const panelRef = useRef<HTMLElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const parent = useContext(SlideOverLayer);
  const [layer] = useState<Layer>(() => ({ parent }));
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    stack(layer);
    restoreRef.current = document.activeElement as HTMLElement;
    const panel = panelRef.current;
    if (openStack[openStack.length - 1] === layer) panel?.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (openStack[openStack.length - 1] !== layer) return;
      if (e.key === "Escape") {
        if (e.defaultPrevented) return;
        onCloseRef.current();
        return;
      }
      if (e.key === "Tab" && panel) {
        const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
          (n) => n.offsetParent !== null,
        );
        if (nodes.length === 0) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (!panel.contains(document.activeElement)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        } else if (e.shiftKey && document.activeElement === first) {
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
      openStack.splice(openStack.indexOf(layer), 1);
      restoreRef.current?.focus?.();
    };
  }, [open, layer]);

  if (!open) return null;
  const layered = <SlideOverLayer.Provider value={layer}>{children}</SlideOverLayer.Provider>;
  // On `body`: inside a sticky ancestor it paints under that ancestor's sticky siblings (ISS-1327).
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex justify-end"
      style={{ background: "var(--scrim)", backdropFilter: "blur(8px)" }}
      onClick={onClose}
    >
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        // The title it draws is its name, so a screen reader announces which sheet opened.
        {...(hideHeader ? {} : { "aria-labelledby": titleId })}
        className="forge-slide flex h-full w-full max-w-[100vw] flex-col border-l border-line bg-surface shadow-lg sm:w-[var(--slide-over-w)]"
        style={{ "--slide-over-w": slideOverWidth } as CSSProperties}
        onClick={(e) => e.stopPropagation()}
      >
        {!hideHeader && (
          <header className="flex flex-none items-center justify-between gap-3 border-b border-line px-5 py-4">
            <div id={titleId} className="fg-h3 min-w-0 flex-1" data-testid="slide-over-title">
              {title}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="shrink-0 rounded-md p-1 text-subtle transition-colors hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
            >
              <Icon name="x" size={18} />
            </button>
          </header>
        )}
        {fitBody ? (
          <div className="flex min-h-0 flex-1 flex-col">{layered}</div>
        ) : (
          <div className="flex-1 overflow-y-auto px-5 py-4">{layered}</div>
        )}
      </aside>
    </div>,
    document.body,
  );
}
