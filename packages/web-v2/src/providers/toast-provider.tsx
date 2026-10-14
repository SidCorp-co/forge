"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Toast, type ToastView } from "@/design/primitives/toast";
import { cn } from "@/lib/utils/cn";

/** More than this and the oldest visible toast gives up its place. */
export const MAX_VISIBLE_TOASTS = 3;

interface ToastItem extends ToastView {
  id: number;
  slot?: string;
}

export interface ToastInput extends ToastView {
  duration?: number;
  /** A toast naming a slot replaces the visible one holding the same slot, so
   *  a burst of one kind of event takes one card rather than a stack. */
  slot?: string;
}

interface ToastApi {
  toast: (t: ToastInput) => void;
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
        // A clickable toast dismisses itself after its action runs.
        onClick={
          t.onClick
            ? () => {
                t.onClick?.();
                remove(t.id);
              }
            : undefined
        }
        onClose={() => remove(t.id)}
      />
    </div>
  ));
}

/**
 * Where a frame's toasts go: an overlay at every width, over the top edge and clear of the bottom
 * one, where a page's save bar and a phone's tab bar sit. A lane in the page flow took its height
 * out of the column and lifted every bottom-anchored thing for as long as a toast showed (ISS-1171),
 * so it lets touches through everywhere but the toasts instead. On a wide screen it keeps to the
 * right, below the top bar. Its height is capped so the reading area keeps most of the column;
 * anything past the cap scrolls inside the lane. `className` carries the frame's own clearance.
 */
export function ToastLane({ className }: { className?: string }) {
  const lane = useContext(ToastLaneContext);
  if (!lane) throw new Error("ToastLane must be used within <ToastProvider>");
  const { items, remove, registerLane } = lane;

  useEffect(() => registerLane(), [registerLane]);

  if (items.length === 0) return null;
  return (
    <section
      aria-label="Notifications"
      data-testid="toast-lane"
      className={cn(
        "flex max-h-[35dvh] flex-col items-end gap-2.5 overflow-y-auto px-5 py-3",
        "pointer-events-none fixed inset-x-0 top-[env(safe-area-inset-top)] z-[60] md:left-auto md:top-14",
        className,
      )}
    >
      <ToastStack items={items} remove={remove} />
    </section>
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
    ({ duration = 4000, slot, ...view }) => {
      const id = ++idRef.current;
      setItems((xs) => {
        const kept = slot === undefined ? xs : xs.filter((x) => x.slot !== slot);
        return [...kept, { id, slot, ...view }].slice(-MAX_VISIBLE_TOASTS);
      });
      if (duration > 0) setTimeout(() => remove(id), duration);
    },
    [remove],
  );

  const registerLane = useCallback(() => {
    setLanes((n) => n + 1);
    return () => setLanes((n) => n - 1);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
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
