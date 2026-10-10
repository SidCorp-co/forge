"use client";


import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useRef,
  useState,
} from "react";
import Image from "next/image";
import { MediaOverlay } from "@/design";
import { cn } from "@/lib/utils/cn";
import { useCopy } from "@/lib/i18n/interface-language";

export interface LightboxImage {
  id: string;
  name: string;
  /** What a screen reader reads for it where its name says nothing; absent, the name. */
  alt?: string;
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

function useZoomPan(index: number, go: (delta: number) => void) {
  // Zoom/pan transform for the current image. `scale === 1` means "fit", and
  // panning is disabled. Reset whenever the image changes (see effect below).
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const zoomed = scale > 1;

  // Active pointers (for pinch) keyed by pointerId, plus drag bookkeeping. Kept
  // in refs so the move handler reads live values without re-subscribing.
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchStartRef = useRef<{ dist: number; scale: number } | null>(null);
  const dragStartRef = useRef<{
    x: number;
    y: number;
    ox: number;
    oy: number;
    moved: boolean;
  } | null>(null);

  // a new image opens at fit: the zoom is reset while rendering when the index moves
  const [shownIndex, setShownIndex] = useState(index);
  if (shownIndex !== index) {
    setShownIndex(index);
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }

  const resetZoom = () => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  };

  const zoomBy = (delta: number) => {
    setScale((s) => {
      const next = clamp(s + delta, MIN_SCALE, MAX_SCALE);
      if (next === MIN_SCALE) setOffset({ x: 0, y: 0 });
      return next;
    });
  };

  // ── Pointer gestures (mouse + touch unified): pan when zoomed, pinch with two
  // fingers, swipe-to-navigate when at fit scale, double-tap/click to toggle.
  const onPointerDown = (e: ReactPointerEvent) => {
      (e.target as Element).setPointerCapture?.(e.pointerId);
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointersRef.current.size === 2) {
        const [a, b] = [...pointersRef.current.values()];
        pinchStartRef.current = { dist: dist(a, b), scale };
        dragStartRef.current = null;
      } else if (pointersRef.current.size === 1) {
        dragStartRef.current = {
          x: e.clientX,
          y: e.clientY,
          ox: offset.x,
          oy: offset.y,
          moved: false,
        };
      }
    };

  const onPointerMove = (e: ReactPointerEvent) => {
      if (!pointersRef.current.has(e.pointerId)) return;
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

      // Pinch-zoom.
      if (pointersRef.current.size === 2 && pinchStartRef.current) {
        const [a, b] = [...pointersRef.current.values()];
        const ratio = dist(a, b) / (pinchStartRef.current.dist || 1);
        setScale(clamp(pinchStartRef.current.scale * ratio, MIN_SCALE, MAX_SCALE));
        return;
      }

      // Single-pointer drag → pan (only meaningful when zoomed).
      const d = dragStartRef.current;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) > TAP_SLOP) d.moved = true;
      if (zoomed) setOffset({ x: d.ox + dx, y: d.oy + dy });
    };

  const endPointer = (e: ReactPointerEvent) => {
      const d = dragStartRef.current;
      const wasPinching = pointersRef.current.size === 2;
      pointersRef.current.delete(e.pointerId);
      if (pointersRef.current.size < 2) pinchStartRef.current = null;
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
      dragStartRef.current = null;
    };

  // Ctrl/Cmd + wheel zooms; plain wheel is left alone (page is scroll-locked).
  const onWheel = (e: ReactWheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
    };

  const toggleZoom = () => {
    if (zoomed) resetZoom();
    else setScale(2);
  };

  return {
    scale,
    offset,
    zoomed,
    moving: dragStartRef.current?.moved ?? false,
    zoomBy,
    resetZoom,
    onPointerDown,
    onPointerMove,
    endPointer,
    onWheel,
    toggleZoom,
  };
}

const GLYPH =
  "flex size-9 items-center justify-center rounded-md leading-none text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-30 sm:size-8";

function LightboxHeader({
  image,
  index,
  count,
  scale,
  zoomBy,
  resetZoom,
  onClose,
}: {
  image: LightboxImage;
  index: number;
  count: number;
  scale: number;
  zoomBy: (delta: number) => void;
  resetZoom: () => void;
  onClose: () => void;
}) {
  const t = useCopy();
  return (
    <header className="flex flex-none items-center justify-between gap-2 px-3 py-2 text-white sm:px-4 sm:py-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className="fg-body-sm truncate" title={image.name}>
          {image.name}
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
          aria-label={t("issues.image.zoomOut")}
          className={cn(GLYPH, "text-lg")}
        >
          &minus;
        </button>
        <button
          type="button"
          onClick={resetZoom}
          aria-label={t("issues.image.resetZoom")}
          className="fg-caption min-w-11 rounded-md px-1 py-1.5 tabular-nums text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:shadow-focus"
        >
          {Math.round(scale * 100)}%
        </button>
        <button
          type="button"
          onClick={() => zoomBy(ZOOM_STEP)}
          disabled={scale >= MAX_SCALE}
          aria-label={t("issues.image.zoomIn")}
          className={cn(GLYPH, "text-lg")}
        >
          +
        </button>
        <a
          href={image.href}
          target="_blank"
          rel="noreferrer noopener"
          className="fg-caption ml-1 hidden rounded-md px-2 py-1.5 text-white/80 transition-colors hover:bg-white/10 hover:text-white sm:inline-flex"
        >
          Open original
        </a>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
          className={cn(GLYPH, "text-xl")}
        >
          &times;
        </button>
      </div>
    </header>
  );
}

function Thumbnails({ images, index, onPick }: { images: LightboxImage[]; index: number; onPick: (i: number) => void }) {
  const t = useCopy();
  return (
    <div className="flex flex-none justify-start gap-2 overflow-x-auto px-3 py-2 sm:justify-center sm:px-4 sm:py-3">
      {images.map((img, i) => (
        <button
          key={img.id}
          type="button"
          onClick={() => onPick(i)}
          aria-label={t("issues.image.view", { name: img.name })}
          aria-current={i === index}
          className={cn("flex-none overflow-hidden rounded-md border-2 transition-colors", i === index ? "border-info-8" : "border-transparent opacity-60 hover:opacity-100")}
        >
          {/* unoptimized: an attachment served from the API by an authenticated URL the Next image optimizer cannot fetch */}
          <Image unoptimized src={img.href} alt={img.alt ?? img.name} width={56} height={56} className="size-11 object-cover sm:size-14" />
        </button>
      ))}
    </div>
  );
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
  const t = useCopy();
  const count = images.length;
  const current = images[index];
  const go = (delta: number) => {
    if (count <= 1) return;
    onIndexChange((index + delta + count) % count);
  };
  const { scale, offset, zoomed, moving, zoomBy, resetZoom, ...gesture } = useZoomPan(index, go);
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowRight") go(1);
    else if (e.key === "ArrowLeft") go(-1);
    else if (e.key === "+" || e.key === "=") zoomBy(ZOOM_STEP);
    else if (e.key === "-") zoomBy(-ZOOM_STEP);
    else if (e.key === "0") resetZoom();
  };

  if (!current) return null;

  return (
    <MediaOverlay open onOpenChange={(open) => !open && onClose()} onKeyDown={onKey} label={t("issues.image.position", { at: index + 1, of: count, name: current.name })}>
      <LightboxHeader image={current} index={index} count={count} scale={scale} zoomBy={zoomBy} resetZoom={resetZoom} onClose={onClose} />

      {/* Stage. */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-2 pb-2 sm:px-4">
        {count > 1 && (
          <button
            type="button"
            onClick={() => go(-1)}
            aria-label={t("issues.image.previous")}
            className="absolute left-2 z-10 flex size-11 items-center justify-center rounded-pill bg-white/10 text-2xl leading-none text-white transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:shadow-focus sm:left-3 sm:size-10"
          >
            &lsaquo;
          </button>
        )}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: the pointer pan and zoom surface; the header's zoom buttons are its keyboard equivalent */}
        <div
          className="relative h-full w-full touch-none select-none"
          onPointerDown={gesture.onPointerDown}
          onPointerMove={gesture.onPointerMove}
          onPointerUp={gesture.endPointer}
          onPointerCancel={gesture.endPointer}
          onWheel={gesture.onWheel}
          onDoubleClick={gesture.toggleZoom}
        >
          {/* unoptimized: an attachment served from the API by an authenticated URL the Next image optimizer cannot fetch */}
          <Image
            unoptimized
            fill
            sizes="100vw"
            src={current.href}
            alt={current.alt ?? current.name}
            draggable={false}
            className="object-contain will-change-transform"
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
              transition: moving ? "none" : "transform 120ms ease-out",
              cursor: zoomed ? "grab" : "zoom-in",
            }}
          />
        </div>
        {count > 1 && (
          <button
            type="button"
            onClick={() => go(1)}
            aria-label={t("issues.image.next")}
            className="absolute right-2 z-10 flex size-11 items-center justify-center rounded-pill bg-white/10 text-2xl leading-none text-white transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:shadow-focus sm:right-3 sm:size-10"
          >
            &rsaquo;
          </button>
        )}
      </div>

      {count > 1 && <Thumbnails images={images} index={index} onPick={onIndexChange} />}
    </MediaOverlay>
  );
}
