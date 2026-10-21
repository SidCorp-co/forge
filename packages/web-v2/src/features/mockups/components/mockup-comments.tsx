import { useRef, useState, type PointerEvent } from "react";
import { ActorChip, Button, Textarea } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { cn } from "@/lib/utils/cn";
import { useCommentMockup } from "../hooks";
import type { MockupCommentView, MockupPin } from "../types";

const pct = (f: number) => `${Math.round(f * 1000) / 10}%`;

/** Where a comment points, in words: a point or a region of the frame, as shares of its size. */
export function pinWords(pin: MockupPin | null, t: ReturnType<typeof useCopy>): string {
  if (!pin) return t("common.mockups.pinNone");
  if (pin.w === undefined || pin.h === undefined) return t("common.mockups.pinPoint", { x: pct(pin.x), y: pct(pin.y) });
  return t("common.mockups.pinRegion", { x: pct(pin.x), y: pct(pin.y), w: pct(pin.w), h: pct(pin.h) });
}

// a fraction of the frame to four places: a hundredth of a percent, finer than any pointer
const frac = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1e4) / 1e4;
// a press that moves less than this, in pixels, is a point, not a region
const DRAG = 6;

/**
 * The marks over a mockup's frame: each pinned comment's number at its point or around its region,
 * and, while `picking`, a layer that takes a press as a point or a drag as a region (REQ-49 BC-2).
 * Positions are fractions of the frame, so a mark points at the same place at any size.
 */
export function PinLayer({
  comments,
  active,
  picking,
  draft,
  onPick,
}: {
  comments: readonly MockupCommentView[];
  active: string | null;
  picking: boolean;
  draft: MockupPin | null;
  onPick: (pin: MockupPin) => void;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [from, setFrom] = useState<{ x: number; y: number; px: number; py: number } | null>(null);
  const [to, setTo] = useState<{ x: number; y: number } | null>(null);
  const at = (e: PointerEvent) => {
    const r = layerRef.current?.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return null;
    return { x: frac((e.clientX - r.left) / r.width), y: frac((e.clientY - r.top) / r.height), px: e.clientX, py: e.clientY };
  };
  const done = (e: PointerEvent) => {
    const end = at(e);
    if (!from || !end) return;
    setFrom(null);
    setTo(null);
    if (Math.abs(end.px - from.px) < DRAG && Math.abs(end.py - from.py) < DRAG) return onPick({ x: from.x, y: from.y });
    const w = frac(Math.abs(end.x - from.x));
    const h = frac(Math.abs(end.y - from.y));
    // a drag along an edge, flat in one direction, encloses nothing: it marks where it began
    if (!w || !h) return onPick({ x: from.x, y: from.y });
    onPick({ x: Math.min(from.x, end.x), y: Math.min(from.y, end.y), w, h });
  };
  const live = from && to ? { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), w: Math.abs(to.x - from.x), h: Math.abs(to.y - from.y) } : null;
  const pinned = comments.flatMap((c, i) => (c.pin ? [{ c, n: i + 1, pin: c.pin }] : []));
  return (
    <div
      ref={layerRef}
      className={cn("absolute inset-0", picking ? "cursor-crosshair bg-accent-tint/20" : "pointer-events-none")}
      data-testid="mockup-pin-layer"
      data-picking={picking ? "true" : "false"}
      onPointerDown={
        picking
          ? (e) => {
              const p = at(e);
              if (p) setFrom(p);
            }
          : undefined
      }
      onPointerMove={picking && from ? (e) => setTo(at(e)) : undefined}
      onPointerUp={picking ? done : undefined}
    >
      {pinned.map(({ c, n, pin }) => (
        <Mark key={c.id} n={n} pin={pin} active={active === c.id} settled={c.settled !== null} />
      ))}
      {draft ? <Mark n={0} pin={draft} active settled={false} /> : null}
      {live ? <Mark n={0} pin={live} active settled={false} /> : null}
    </div>
  );
}

function Mark({ n, pin, active, settled }: { n: number; pin: MockupPin; active: boolean; settled: boolean }) {
  const region = pin.w !== undefined && pin.h !== undefined;
  const tone = settled ? "border-muted bg-muted text-on-accent" : "border-accent bg-accent text-on-accent";
  return (
    <span
      className="pointer-events-none absolute"
      style={{ left: pct(pin.x), top: pct(pin.y), ...(region ? { width: pct(pin.w ?? 0), height: pct(pin.h ?? 0) } : {}) }}
      data-testid="mockup-pin"
      data-n={n}
    >
      {region ? <span className={cn("absolute inset-0 border-2", settled ? "border-muted" : "border-accent", active ? "bg-accent-tint/30" : "")} /> : null}
      <span
        className={cn(
          "absolute flex size-6 items-center justify-center rounded-full border-2 text-12 font-semibold",
          region ? "-top-3 -left-3" : "-translate-x-1/2 -translate-y-1/2",
          tone,
          active ? "ring-2 ring-accent ring-offset-1" : "",
        )}
      >
        {n === 0 ? "+" : n}
      </span>
    </span>
  );
}

/** Each comment on a mockup and the revisions before it: its number on the frame, where it points, and how a revision settled it. */
export function CommentList({
  comments,
  active,
  onActive,
}: {
  comments: readonly MockupCommentView[];
  active: string | null;
  onActive: (id: string | null) => void;
}) {
  const t = useCopy();
  const time = useTimeFormat();
  if (!comments.length) return <p className="px-4 py-3 text-13 text-subtle">{t("common.mockups.noComments")}</p>;
  return (
    <ol className="divide-y divide-line-subtle" data-testid="mockup-comments">
      {comments.map((c, i) => (
        <li key={c.id} data-testid="mockup-comment" data-on={c.on}>
          <button
            type="button"
            onClick={() => onActive(active === c.id ? null : c.id)}
            className={cn("grid w-full gap-1 px-4 py-3 text-left hover:bg-hover focus-visible:shadow-focus focus-visible:outline-none", active === c.id ? "bg-sel" : "")}
          >
            <span className="flex items-center gap-2 text-12 text-muted">
              <span className={cn("flex size-5 flex-none items-center justify-center rounded-full text-11 font-semibold", c.settled ? "bg-muted text-on-accent" : "bg-accent text-on-accent")}>{i + 1}</span>
              <ActorChip name={c.authorName ?? t("standing.who.itsAuthor")} kind={c.authorAgency} size={16} />
              <span className="ml-auto">{time.relative(c.createdAt)}</span>
            </span>
            <span className="text-13 whitespace-pre-wrap text-fg">{c.body}</span>
            <span className="text-12 text-subtle">
              {pinWords(c.pin, t)} · {t("common.mockups.commentOn", { key: c.on })}
            </span>
            {c.settled ? (
              <span className="text-12 text-muted" data-testid="mockup-comment-settled">
                {t(c.settled.as === "answered" ? "common.mockups.answeredBy" : "common.mockups.resolvedBy", { key: c.settled.by })}
                {c.settled.note ? ` — ${c.settled.note}` : ""}
              </span>
            ) : null}
          </button>
        </li>
      ))}
    </ol>
  );
}

/** What a person says about a mockup, pinned where the frame was pressed or to nothing. */
export function CommentComposer({
  projectId,
  mockupKey,
  pin,
  picking,
  onPicking,
  onClearPin,
}: {
  projectId: string;
  mockupKey: string;
  pin: MockupPin | null;
  picking: boolean;
  onPicking: (on: boolean) => void;
  onClearPin: () => void;
}) {
  const t = useCopy();
  const write = useCommentMockup(projectId, mockupKey);
  const [body, setBody] = useState("");
  return (
    <form
      className="grid gap-2 border-t border-line-subtle px-4 py-3"
      data-testid="mockup-comment-form"
      onSubmit={(e) => {
        e.preventDefault();
        write.mutate(
          { body: body.trim(), ...(pin ? { pin } : {}) },
          {
            onSuccess: () => {
              setBody("");
              onClearPin();
            },
          },
        );
      }}
    >
      <div className="flex flex-wrap items-center gap-2 text-12 text-muted">
        <Button type="button" size="sm" variant={picking ? "primary" : "secondary"} aria-pressed={picking} onClick={() => onPicking(!picking)} data-testid="mockup-pin-toggle">
          {picking ? t("common.mockups.pinPicking") : t("common.mockups.pinStart")}
        </Button>
        <span data-testid="mockup-pin-draft">{pinWords(pin, t)}</span>
        {pin ? (
          <button type="button" className="text-accent-text hover:underline" onClick={onClearPin}>
            {t("common.mockups.pinClear")}
          </button>
        ) : null}
      </div>
      <Textarea aria-label={t("common.mockups.commentLabel")} placeholder={t("common.mockups.commentPlaceholder")} value={body} onChange={(e) => setBody(e.target.value)} rows={3} />
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" variant="primary" disabled={!body.trim()} loading={write.isPending}>
          {t("common.mockups.commentPost")}
        </Button>
        <RefusalLine error={write.error} />
      </div>
    </form>
  );
}
