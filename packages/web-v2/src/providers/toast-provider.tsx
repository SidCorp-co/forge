"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useMediaQuery } from "@/design/hooks/use-media-query";
import { Toast, type ToastView } from "@/design/primitives/toast";
import { cn } from "@/lib/utils/cn";

/** More than this and the oldest visible toast gives up its place. */
export const MAX_VISIBLE_TOASTS = 3;

/** The least a toast given no duration stays; one with more to read stays as long as reading it takes. */
const LEAST_MS = 4000;

/** How long a toast's words take to read: about 200 words a minute, and two seconds to find it. */
export function readingMs({ title, description }: Pick<ToastView, "title" | "description">): number {
  const words = `${title} ${description ?? ""}`.split(/\s+/).filter(Boolean).length;
  return Math.max(LEAST_MS, 2000 + words * 300);
}

/** What a toast keeps clear of: one element, or several, the first the one it must never cover. */
type ClearOf = () => Element | null | readonly (Element | null)[];

interface ToastItem extends ToastView {
  id: number;
  slot?: string;
  keep?: boolean;
  clearOf?: ClearOf;
}

export interface ToastInput extends ToastView {
  /** How long it stays, in ms, while nothing holds it; 0 stays until put away. Unset: its reading time. */
  duration?: number;
  /** A toast naming a slot replaces the visible one holding the same slot, so
   *  a burst of one kind of event takes one card rather than a stack. */
  slot?: string;
  /** Holds what the reader would otherwise lose, so it neither expires nor yields its place. */
  keep?: boolean;
  /** The elements the toast must not stand over, such as the field it tells the reader to correct:
   *  while it shows, its lane moves to where it leaves them clear. Where no place clears them all, the
   *  last are let go first; the first is the one it must never cover. */
  clearOf?: ClearOf;
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
  /** Pauses a toast's countdown while the reader is on it, and resumes it with what was left. */
  hold: (id: number, held: boolean) => void;
  registerLane: () => () => void;
}

const ToastContext = createContext<ToastApi | null>(null);
const ToastLaneContext = createContext<ToastLaneApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}

function ToastStack({ items, remove, hold }: Pick<ToastLaneApi, "items" | "remove" | "hold">) {
  return items.map(({ clearOf: _clearOf, ...t }) => (
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
        onHold={(held) => hold(t.id, held)}
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

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

const overlaps = (a: Box, b: Box) => a.top < b.bottom && b.top < a.bottom && a.left < b.right && b.left < a.right;

/** The lane's top edge when nothing moves it: under the top bar on a wide screen, under an open
 *  drawer's header or at the top of the screen on a phone. */
const WIDE_TOP_PX = 56;
/** What the bottom edge keeps clear of: a phone's tab bar, unless a dialog covers it, or a margin. */
const TAB_BAR_PX = 56;
const WIDE_BOTTOM_PX = 16;
/** The lane's own height cap, as its class states it: a share of the viewport's height. */
const LANE_CAP = 0.35;
/** The lane's vertical padding, as its class states it (`py-3`), which a capped place takes away. */
const LANE_PAD_PX = 12;
/** The least space a capped lane takes: a toast's title and the start of its words. Less hides the toast. */
const MIN_ROOM_PX = 72;
const OVER_KEPT_Z = 61;

/** The device's safe-area insets in px, read off a probe: the space a fixed edge keeps clear of. */
function safeInsets(): { top: number; bottom: number } {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;visibility:hidden;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)";
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const insets = { top: Number.parseFloat(style.paddingTop) || 0, bottom: Number.parseFloat(style.paddingBottom) || 0 };
  probe.remove();
  return insets;
}

/**
 * Where the lane goes so that no toast in it stands over the elements one names, nor over the kept
 * notices: the top edge, beside the dialog on a wide screen, the bottom edge, or the widest space left
 * between them, capped, if it holds `MIN_ROOM_PX`. Failing that it goes over the kept notices, then
 * lets go of the elements from the last, never the first (ISS-1236 r10). Null keeps the lane's own
 * place. Measured again on every scroll and resize, as the elements move under it (r9).
 */
function useKeepClear(
  items: ToastItem[],
  lane: React.RefObject<HTMLElement | null>,
  keptLane: React.RefObject<HTMLElement | null>,
  wide: boolean,
  belowDialogHeader: number | null,
): CSSProperties | null {
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const named = items.some((t) => t.clearOf && (wide || !t.keep));
  useLayoutEffect(() => {
    if (!named) {
      setPlace(null);
      return;
    }
    const measure = () => {
      const box = lane.current?.getBoundingClientRect();
      const targets = items.flatMap((t) => {
        const given = wide || !t.keep ? t.clearOf?.() : null;
        const list: readonly (Element | null | undefined)[] = Array.isArray(given)
          ? given
          : [given as Element | null | undefined];
        return list.filter((el): el is Element => !!el);
      });
      if (!box || targets.length === 0) {
        setPlace(null);
        return;
      }
      const rects: Box[] = targets.map((el) => el.getBoundingClientRect());
      const keptBox = keptLane.current?.getBoundingClientRect();
      const kept = keptBox && keptBox.height > 0 ? keptBox : null;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const inset = safeInsets();
      // The height the lane takes where nothing caps it but its own class: neither a cap this placement
      // set nor the padding it took away is read back as the lane's, or the next measure would undo it.
      const laneStyle = lane.current ? getComputedStyle(lane.current) : null;
      const padding =
        (Number.parseFloat(laneStyle?.paddingTop ?? "") || 0) + (Number.parseFloat(laneStyle?.paddingBottom ?? "") || 0);
      const content = (lane.current?.scrollHeight ?? 0) - padding;
      const height = Math.max(box.height, Math.min(content + 2 * LANE_PAD_PX, vh * LANE_CAP));
      const top = belowDialogHeader ?? (wide ? WIDE_TOP_PX : inset.top);
      const left = wide ? vw - box.width : 0;
      const atTop = { top, bottom: top + height, left, right: vw };
      const dialog = targets[0].closest('[role="dialog"]') ?? targets[0];
      const edge = dialog.getBoundingClientRect().left;
      const beside = { ...atTop, left: edge - box.width, right: edge };
      const dialogOpen = belowDialogHeader !== null || document.querySelector('[role="dialog"][aria-modal="true"]');
      const gap = (wide ? WIDE_BOTTOM_PX : dialogOpen ? 0 : TAB_BAR_PX) + inset.bottom;
      const atBottom = { ...atTop, top: vh - gap - height, bottom: vh - gap };
      /** The widest run of the lane's column, between its top and bottom edges, that no obstacle crosses. */
      const widest = (obstacles: Box[]) => {
        const spans = obstacles
          .filter((o) => o.right > left && o.left < vw)
          .map((o) => [Math.max(top, o.top), Math.min(vh - gap, o.bottom)] as const)
          .filter(([from, to]) => to > from)
          .sort((a, b) => a[0] - b[0]);
        let at = top;
        let best = { top, room: 0 };
        for (const [from, to] of [...spans, [vh - gap, vh - gap] as const]) {
          if (from - at > best.room) best = { top: at, room: from - at };
          at = Math.max(at, to);
        }
        return best;
      };
      // The cap is the lane's whole box, so its own padding goes too, or a small gap is overrun.
      const capped = (space: { top: number; room: number }) => ({
        top: space.top,
        maxHeight: space.room,
        paddingTop: 0,
        paddingBottom: 0,
      });

      /** A place clear of the first `n` elements, and of the kept notices where `overKept` is false. */
      const placeFor = (n: number, overKept: boolean): CSSProperties | null | undefined => {
        const held = rects.slice(0, n);
        const obstacles = [...held, ...(kept && !overKept ? [kept] : [])];
        const clear = (b: Box) => obstacles.every((o) => !overlaps(b, o));
        const lift = overKept && kept ? { zIndex: OVER_KEPT_Z } : {};
        if (clear(atTop)) return n === rects.length && !overKept ? null : { ...lift, top };
        if (wide && beside.left >= 0 && clear(beside)) return { ...lift, right: vw - edge };
        if (clear(atBottom)) return { ...lift, top: "auto", bottom: gap };
        const space = widest(obstacles);
        return space.room < MIN_ROOM_PX ? undefined : { ...lift, ...capped(space) };
      };
      const tries: [number, boolean][] = [[rects.length, false]];
      for (let n = rects.length; n >= 1; n--) tries.push([n, true]);
      let next: CSSProperties | null | undefined;
      for (const [n, overKept] of tries) {
        next = placeFor(n, overKept);
        if (next !== undefined) break;
      }
      // Nowhere holds a toast's first line clear of the first element: the widest space, however small.
      if (next === undefined) next = { zIndex: OVER_KEPT_Z, ...capped(widest(rects.slice(0, 1))) };
      setPlace((was) => (JSON.stringify(was) === JSON.stringify(next) ? was : (next ?? null)));
    };
    measure();
    window.addEventListener("scroll", measure, { capture: true, passive: true });
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, { capture: true });
      window.removeEventListener("resize", measure);
    };
  }, [items, named, lane, keptLane, wide, belowDialogHeader]);
  return place;
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
  const { items, remove, hold, registerLane } = lane;
  const wide = useMediaQuery(WIDE);
  const belowDialogHeader = useOpenDialogHeaderBottom(!wide && items.length > 0);
  const laneRef = useRef<HTMLElement>(null);
  const keptRef = useRef<HTMLElement>(null);
  const kept = wide ? [] : items.filter((t) => t.keep);
  const passing = wide ? items : items.filter((t) => !t.keep);
  const clearPlace = useKeepClear(items, laneRef, keptRef, wide, belowDialogHeader);

  useEffect(() => registerLane(), [registerLane]);

  if (items.length === 0 || typeof document === "undefined") return null;
  // On a phone the top of the screen is where a list's first controls and rows are, so a toast that
  // stays until it is put away waits above the tab bar instead (ISS-1229 r30, judge-86).
  return (
    <>
      {passing.length > 0 &&
        createPortal(
          <section
            ref={laneRef}
            aria-label="Notifications"
            data-testid="toast-lane"
            className={cn(
              "flex max-h-[35dvh] flex-col items-end gap-2.5 overflow-y-auto px-5 py-3",
              "pointer-events-none fixed inset-x-0 top-[env(safe-area-inset-top)] z-[60] md:left-auto md:top-14",
              className,
            )}
            style={clearPlace ?? (belowDialogHeader === null ? undefined : { top: belowDialogHeader })}
          >
            <ToastStack items={passing} remove={remove} hold={hold} />
          </section>,
          document.body,
        )}
      {kept.length > 0 &&
        createPortal(
          <section
            ref={keptRef}
            aria-label="Kept notices"
            data-testid="toast-lane-kept"
            className={cn(
              "flex max-h-[35dvh] flex-col items-center gap-2.5 overflow-y-auto px-4 py-3",
              "pointer-events-none fixed inset-x-0 bottom-[calc(56px+env(safe-area-inset-bottom))] z-[60]",
            )}
          >
            <ToastStack items={kept} remove={remove} hold={hold} />
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
  /** Each counting toast's timer: what it had left when it last started counting, and when that was. */
  const timers = useRef(new Map<number, { left: number; since: number; handle: ReturnType<typeof setTimeout> | null }>());

  const remove = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer?.handle) clearTimeout(timer.handle);
    timers.current.delete(id);
    setItems((xs) => xs.filter((x) => x.id !== id));
  }, []);

  const count = useCallback(
    (id: number, left: number) => {
      timers.current.set(id, { left, since: Date.now(), handle: setTimeout(() => remove(id), left) });
    },
    [remove],
  );

  const hold = useCallback<ToastLaneApi["hold"]>(
    (id, held) => {
      const timer = timers.current.get(id);
      if (!timer) return;
      if (held && timer.handle) {
        clearTimeout(timer.handle);
        timers.current.set(id, { left: timer.left - (Date.now() - timer.since), since: 0, handle: null });
      } else if (!held && !timer.handle) {
        count(id, Math.max(0, timer.left));
      }
    },
    [count],
  );

  const toast = useCallback<ToastApi["toast"]>(
    ({ duration, slot, keep, clearOf, ...view }) => {
      const id = ++idRef.current;
      setItems((xs) => {
        const kept = slot === undefined ? xs : xs.filter((x) => x.slot !== slot);
        const next = [...kept, { id, slot, keep, clearOf, ...view }];
        const room = Math.max(1, MAX_VISIBLE_TOASTS - next.filter((x) => x.keep).length);
        const shown = new Set(next.filter((x) => !x.keep).slice(-room));
        return next.filter((x) => x.keep || shown.has(x));
      });
      const lasts = duration ?? readingMs(view);
      if (lasts > 0 && !keep) count(id, lasts);
    },
    [count],
  );

  const dismiss = useCallback<ToastApi["dismiss"]>((slot) => {
    setItems((xs) => xs.filter((x) => x.slot !== slot));
  }, []);

  // A toast leaves by remove, by its slot, by dismiss or by the visible limit: whichever, its
  // countdown, held or running, leaves with it.
  useEffect(() => {
    const shown = new Set(items.map((x) => x.id));
    for (const [id, timer] of timers.current) {
      if (shown.has(id)) continue;
      if (timer.handle) clearTimeout(timer.handle);
      timers.current.delete(id);
    }
  }, [items]);

  useEffect(() => {
    const live = timers.current;
    return () => {
      for (const timer of live.values()) if (timer.handle) clearTimeout(timer.handle);
      live.clear();
    };
  }, []);

  const registerLane = useCallback(() => {
    setLanes((n) => n + 1);
    return () => setLanes((n) => n - 1);
  }, []);

  return (
    <ToastContext.Provider value={{ toast, dismiss }}>
      <ToastLaneContext.Provider value={{ items, remove, hold, registerLane }}>
        {children}
        {lanes === 0 && items.length > 0 ? (
          // A page with no frame has no lane to reserve; the corner is the
          // least-read place it has.
          <div
            data-testid="toast-corner"
            className="pointer-events-none fixed bottom-5 right-5 z-[60] flex flex-col gap-2.5"
          >
            <ToastStack items={items} remove={remove} hold={hold} />
          </div>
        ) : null}
      </ToastLaneContext.Provider>
    </ToastContext.Provider>
  );
}
