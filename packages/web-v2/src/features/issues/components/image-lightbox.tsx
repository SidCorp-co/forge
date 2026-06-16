"use client";

// Gallery lightbox for issue/comment image attachments (ISS-363 follow-up).
// Previously each image thumbnail was an `<a target="_blank">` that dumped the
// full-size file into a new browser tab. Multiple attachments meant multiple
// tabs. This modal keeps the viewer in-app: click a thumbnail to open it here,
// then page through the rest of the image set, and zoom/pan an individual
// image.
//
// Navigation: arrow keys or the on-screen prev/next controls (desktop), or
// horizontal swipe (touch). Zoom: +/-/0 keys, the on-screen zoom controls,
// double-click / double-tap, Ctrl+wheel, or pinch (touch). When zoomed, drag
// (mouse) or one-finger drag (touch) pans; swipe-to-navigate is suspended so
// the gesture pans instead. Esc closes; the backdrop is dismissable; focus is
// restored to the trigger on close. Layout is responsive — controls and the
// thumbnail strip shrink their hit targets / sizing on small screens.
//
// Non-image attachments never reach here — `AttachmentList` only opens images.

import {
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export interface LightboxImage {
  id: string;
  name: string;
  /** Resolved, fetchable URL (already passed through `coreFileUrl`). */
  href: string;
}

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const ZOOM_STEP = 0.5;
// Below this drag distance a pointer gesture counts as a tap/click, not a pan
// or a swipe — keeps double-tap-to-zoom and backdrop-dismiss from misfiring.
const TAP_SLOP = 8;
// Horizontal travel (px) required for a swipe to flip to the next/prev image.
const SWIPE_THRESHOLD = 50;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function ImageLightbox({
  images,
  index,
  onClose,
  onIndexChange,
}: {
  images: LightboxImage[];
  /** Index into `images` of the currently shown image. */
  index: number;
  onClose: () => void;
  onIndexChange: (next: number) => void;
}) {
  const count = images.length;
  const current = images[index];
  const restoreRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Zoom/pan transform for the current image. `scale === 1` means "fit", and
  // panning is disabled. Reset whenever the image changes (see effect below).
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const zoomed = scale > 1;

  // Active pointers (for pinch) keyed by pointerId, plus drag bookkeeping. Kept
  // in refs so the move handler reads live values without re-subscribing.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchStart = useRef<{ dist: number; scale: number } | null>(null);
  const dragStart = useRef<{
    x: number;
    y: number;
    ox: number;
    oy: number;
    moved: boolean;
  } | null>(null);

  const resetZoom = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  const go = useCallback(
    (delta: number) => {
      if (count <= 1) return;
      onIndexChange((index + delta + count) % count);
    },
    [count, index, onIndexChange],
  );

  const zoomBy = useCallback((delta: number) => {
    setScale((s) => {
      const next = clamp(s + delta, MIN_SCALE, MAX_SCALE);
      if (next === MIN_SCALE) setOffset({ x: 0, y: 0 });
      return next;
    });
  }, []);

  // Reset zoom when the shown image changes (navigation, thumbnail pick).
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset is keyed on the image index, not the resetZoom identity
  useEffect(() => {
    resetZoom();
  }, [index]);

  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "+" || e.key === "=") zoomBy(ZOOM_STEP);
      else if (e.key === "-") zoomBy(-ZOOM_STEP);
      else if (e.key === "0") resetZoom();
    };
    document.addEventListener("keydown", onKey);
    // Lock background scroll while the gallery is open.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      restoreRef.current?.focus?.();
    };
  }, [onClose, go, zoomBy, resetZoom]);

  // ── Pointer gestures (mouse + touch unified): pan when zoomed, pinch with two
  // fingers, swipe-to-navigate when at fit scale, double-tap/click to toggle.
  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      (e.target as Element).setPointerCapture?.(e.pointerId);
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.current.size === 2) {
        const [a, b] = [...pointers.current.values()];
        pinchStart.current = { dist: dist(a, b), scale };
        dragStart.current = null;
      } else if (pointers.current.size === 1) {
        dragStart.current = {
          x: e.clientX,
          y: e.clientY,
          ox: offset.x,
          oy: offset.y,
          moved: false,
        };
      }
    },
    [scale, offset],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      if (!pointers.current.has(e.pointerId)) return;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

      // Pinch-zoom.
      if (pointers.current.size === 2 && pinchStart.current) {
        const [a, b] = [...pointers.current.values()];
        const ratio = dist(a, b) / (pinchStart.current.dist || 1);
        setScale(clamp(pinchStart.current.scale * ratio, MIN_SCALE, MAX_SCALE));
        return;
      }

      // Single-pointer drag → pan (only meaningful when zoomed).
      const d = dragStart.current;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) > TAP_SLOP) d.moved = true;
      if (zoomed) setOffset({ x: d.ox + dx, y: d.oy + dy });
    },
    [zoomed],
  );

  const endPointer = useCallback(
    (e: ReactPointerEvent) => {
      const d = dragStart.current;
      const wasPinching = pointers.current.size === 2;
      pointers.current.delete(e.pointerId);
      if (pointers.current.size < 2) pinchStart.current = null;
      // Snap an over-pinched-down image back to fit.
      if (wasPinching) {
        setScale((s) => {
          if (s <= MIN_SCALE) setOffset({ x: 0, y: 0 });
          return s;
        });
      }

      // Swipe-to-navigate: only at fit scale (when zoomed, the drag panned).
      if (d && !zoomed && d.moved) {
        const dx = e.clientX - d.x;
        if (Math.abs(dx) > SWIPE_THRESHOLD) go(dx < 0 ? 1 : -1);
      }
      dragStart.current = null;
    },
    [zoomed, go],
  );

  // Ctrl/Cmd + wheel zooms; plain wheel is left alone (page is scroll-locked).
  const onWheel = useCallback(
    (e: ReactWheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
    },
    [zoomBy],
  );

  const toggleZoom = useCallback(() => {
    if (zoomed) resetZoom();
    else setScale(2);
  }, [zoomed, resetZoom]);

  if (!current) return null;

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Image ${index + 1} of ${count}: ${current.name}`}
      tabIndex={-1}
      className="fixed inset-0 z-[60] flex flex-col outline-none"
      style={{ background: "rgba(15,17,21,0.82)", backdropFilter: "blur(6px)" }}
      onClick={onClose}
    >
      {/* Top bar: name, counter, zoom controls, open-original, close. */}
      <header
        className="flex flex-none items-center justify-between gap-2 px-3 py-2 text-white sm:px-4 sm:py-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="fg-body-sm truncate" title={current.name}>
            {current.name}
          </span>
          {count > 1 && (
            <span className="fg-caption flex-none text-white/60">
              {index + 1} / {count}
            </span>
          )}
        </div>
        <div className="flex flex-none items-center gap-0.5 sm:gap-1">
          {/* Zoom controls. Glyph buttons keep us off the (minus-less) icon set. */}
          <button
            type="button"
            onClick={() => zoomBy(-ZOOM_STEP)}
            disabled={scale <= MIN_SCALE}
            aria-label="Zoom out"
            className="flex size-9 items-center justify-center rounded-md text-lg leading-none text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] disabled:opacity-30 sm:size-8"
          >
            &minus;
          </button>
          <button
            type="button"
            onClick={resetZoom}
            aria-label="Reset zoom"
            className="fg-caption min-w-11 rounded-md px-1 py-1.5 tabular-nums text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
          >
            {Math.round(scale * 100)}%
          </button>
          <button
            type="button"
            onClick={() => zoomBy(ZOOM_STEP)}
            disabled={scale >= MAX_SCALE}
            aria-label="Zoom in"
            className="flex size-9 items-center justify-center rounded-md text-lg leading-none text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] disabled:opacity-30 sm:size-8"
          >
            +
          </button>
          <a
            href={current.href}
            target="_blank"
            rel="noreferrer noopener"
            className="fg-caption ml-1 hidden rounded-md px-2 py-1.5 text-white/80 transition-colors hover:bg-white/10 hover:text-white sm:inline-flex"
          >
            Open original
          </a>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex size-9 items-center justify-center rounded-md text-xl leading-none text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] sm:size-8"
          >
            &times;
          </button>
        </div>
      </header>

      {/* Stage. */}
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-2 pb-2 sm:px-4"
        onClick={(e) => e.stopPropagation()}
      >
        {count > 1 && (
          <button
            type="button"
            onClick={() => go(-1)}
            aria-label="Previous image"
            className="absolute left-2 z-10 flex size-11 items-center justify-center rounded-pill bg-white/10 text-2xl leading-none text-white transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] sm:left-3 sm:size-10"
          >
            &lsaquo;
          </button>
        )}
        <div
          className="flex h-full w-full touch-none select-none items-center justify-center"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
          onWheel={onWheel}
          onDoubleClick={toggleZoom}
        >
          {/* biome-ignore lint/a11y/useAltText: alt is the file name */}
          <img
            src={current.href}
            alt={current.name}
            draggable={false}
            className="max-h-full max-w-full object-contain will-change-transform"
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
              transition: dragStart.current?.moved ? "none" : "transform 120ms ease-out",
              cursor: zoomed ? "grab" : "zoom-in",
            }}
          />
        </div>
        {count > 1 && (
          <button
            type="button"
            onClick={() => go(1)}
            aria-label="Next image"
            className="absolute right-2 z-10 flex size-11 items-center justify-center rounded-pill bg-white/10 text-2xl leading-none text-white transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] sm:right-3 sm:size-10"
          >
            &rsaquo;
          </button>
        )}
      </div>

      {/* Thumbnail strip — only when there is more than one image. */}
      {count > 1 && (
        <div
          className="flex flex-none justify-start gap-2 overflow-x-auto px-3 py-2 sm:justify-center sm:px-4 sm:py-3"
          onClick={(e) => e.stopPropagation()}
        >
          {images.map((img, i) => (
            <button
              key={img.id}
              type="button"
              onClick={() => onIndexChange(i)}
              aria-label={`View ${img.name}`}
              aria-current={i === index}
              className={`flex-none overflow-hidden rounded-md border-2 transition-colors ${
                i === index
                  ? "border-cobalt-400"
                  : "border-transparent opacity-60 hover:opacity-100"
              }`}
            >
              {/* biome-ignore lint/a11y/useAltText: alt is the file name */}
              <img
                src={img.href}
                alt={img.name}
                className="size-11 object-cover sm:size-14"
              />
            </button>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}
