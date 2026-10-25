"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMediaQuery } from "@/design/hooks/use-media-query";
import { Toast, type ToastView } from "@/design/primitives/toast";
import { cn } from "@/lib/utils/cn";

/** More than this and the oldest visible toast gives up its place. */
export const MAX_VISIBLE_TOASTS = 3;

interface ToastItem extends ToastView {
  id: number;
  slot?: string;
  keep?: boolean;
}

export interface ToastInput extends ToastView {
  duration?: number;
  /** A toast naming a slot replaces the visible one holding the same slot, so
   *  a burst of one kind of event takes one card rather than a stack. */
  slot?: string;
  /** Holds what the reader would otherwise lose, so it neither expires nor yields its place. */
  keep?: boolean;
}

interface ToastApi {
  toast: (t: ToastInput) => void;
  /** Removes the visible toasts holding `slot`, and no other: a notice about a screen that has just
   *  given way to the next one, which would otherwise sit over it for the rest of its time. */
  dismiss: (slot: string) => void;
}

interface ToastLaneApi {
  items: ToastItem[];
  remove: (id: number) => void;
  registerLane: () => () => void;
}

const ToastContext = createContext<ToastApi | null>(null);
const ToastLaneContext = createContext<ToastLaneApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}

function ToastStack({ items, remove }: Pick<ToastLaneApi, "items" | "remove">) {
  return items.map((t) => (
    <div key={t.id} className="pointer-events-auto">
      <Toast
        {...t}
        // A clickable toast goes once its action runs; a kept one holds what the reader would lose, so it
        // stays to be used again and only its Dismiss control puts it away (ISS-1229 r30, judge-86).
        onClick={
          t.onClick
            ? () => {
                t.onClick?.();
                if (!t.keep) remove(t.id);
              }
            : undefined
        }
        onClose={() => remove(t.id)}
      />
    </div>
  ));
}

const WIDE = "(min-width: 768px)";

/** Where the open dialog's header ends, or null. On a phone a toast at the top covered a drawer's title,
 *  state and close control (ISS-1421 r27), so the lane starts below that header instead. */
function useOpenDialogHeaderBottom(watch: boolean): number | null {
  const [bottom, setBottom] = useState<number | null>(null);
  useEffect(() => {
    if (!watch) {
      setBottom(null);
      return;
    }
    const read = () => {
      const open = document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]');
      const header = open[open.length - 1]?.querySelector("header");
      const edge = header ? Math.round(header.getBoundingClientRect().bottom) : 0;
      setBottom(edge > 0 ? edge : null);
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", read);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", read);
    };
  }, [watch]);
  return bottom;
}

/**
 * Where a frame's toasts go: an overlay at every width, over the top edge and clear of the bottom
 * one, where a page's save bar and a phone's tab bar sit. A lane in the page flow took its height
 * out of the column and lifted every bottom-anchored thing for as long as a toast showed (ISS-1171),
 * so it lets touches through everywhere but the toasts instead. On a wide screen it keeps to the
 * right, below the top bar. Its height is capped so the reading area keeps most of the column;
 * anything past the cap scrolls inside the lane. `className` carries the frame's own clearance.
 * It renders through a portal on `<body>`, as every layer in popover.tsx's stacking note does, so
 * its tier is compared with an open dialog's and not trapped under it by the frame (ISS-1289).
 */
export function ToastLane({ className }: { className?: string }) {
  const lane = useContext(ToastLaneContext);
  if (!lane) throw new Error("ToastLane must be used within <ToastProvider>");
  const { items, remove, registerLane } = lane;
  const wide = useMediaQuery(WIDE);
  const belowDialogHeader = useOpenDialogHeaderBottom(!wide && items.length > 0);

  useEffect(() => registerLane(), [registerLane]);

  if (items.length === 0 || typeof document === "undefined") return null;
  // On a phone the top of the screen is where a list's first controls and rows are, so a toast that
  // stays until it is put away waits above the tab bar instead (ISS-1229 r30, judge-86).
  const kept = wide ? [] : items.filter((t) => t.keep);
  const passing = wide ? items : items.filter((t) => !t.keep);
  return (
    <>
      {passing.length > 0 &&
        createPortal(
          <section
            aria-label="Notifications"
            data-testid="toast-lane"
            className={cn(
              "flex max-h-[35dvh] flex-col items-end gap-2.5 overflow-y-auto px-5 py-3",
              "pointer-events-none fixed inset-x-0 top-[env(safe-area-inset-top)] z-[60] md:left-auto md:top-14",
              className,
            )}
            style={belowDialogHeader === null ? undefined : { top: belowDialogHeader }}
          >
            <ToastStack items={passing} remove={remove} />
          </section>,
          document.body,
        )}
      {kept.length > 0 &&
        createPortal(
          <section
            aria-label="Kept notices"
            data-testid="toast-lane-kept"
            className={cn(
              "flex max-h-[35dvh] flex-col items-center gap-2.5 overflow-y-auto px-4 py-3",
              "pointer-events-none fixed inset-x-0 bottom-[calc(56px+env(safe-area-inset-bottom))] z-[60]",
            )}
          >
            <ToastStack items={kept} remove={remove} />
          </section>,
          document.body,
        )}
    </>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const [lanes, setLanes] = useState(0);
  const idRef = useRef(0);

  const remove = useCallback((id: number) => {
    setItems((xs) => xs.filter((x) => x.id !== id));
  }, []);

  const toast = useCallback<ToastApi["toast"]>(
    ({ duration = 4000, slot, keep, ...view }) => {
      const id = ++idRef.current;
      setItems((xs) => {
        const kept = slot === undefined ? xs : xs.filter((x) => x.slot !== slot);
        const next = [...kept, { id, slot, keep, ...view }];
        const room = Math.max(1, MAX_VISIBLE_TOASTS - next.filter((x) => x.keep).length);
        const shown = new Set(next.filter((x) => !x.keep).slice(-room));
        return next.filter((x) => x.keep || shown.has(x));
      });
      if (duration > 0 && !keep) setTimeout(() => remove(id), duration);
    },
    [remove],
  );

  const dismiss = useCallback<ToastApi["dismiss"]>((slot) => {
    setItems((xs) => xs.filter((x) => x.slot !== slot));
  }, []);

  const registerLane = useCallback(() => {
    setLanes((n) => n + 1);
    return () => setLanes((n) => n - 1);
  }, []);

  return (
    <ToastContext.Provider value={{ toast, dismiss }}>
      <ToastLaneContext.Provider value={{ items, remove, registerLane }}>
        {children}
        {lanes === 0 && items.length > 0 ? (
          // A page with no frame has no lane to reserve; the corner is the
          // least-read place it has.
          <div
            data-testid="toast-corner"
            className="pointer-events-none fixed bottom-5 right-5 z-[60] flex flex-col gap-2.5"
          >
            <ToastStack items={items} remove={remove} />
          </div>
        ) : null}
      </ToastLaneContext.Provider>
    </ToastContext.Provider>
  );
}
