"use client";

import { BaseEdge, type EdgeProps, EdgeLabelRenderer, Handle, type NodeProps, Position } from "@xyflow/react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { memo, useRef } from "react";
import { Button, Popover, useHoverCard } from "@/design";
import type { DBox, DCaption, Diagram, DLine } from "../c4/geometry";
import { FONT } from "../c4/geometry";
import { IntegrationBadge } from "../components/workflow-parts";
import type { StepMark } from "../design-diff";
import { MARK_HUE } from "./style";

// cm:why a C4 diagram is drawn by the same canvas as every other design (owner, 2026-10-04): only the
// layout differs, so its boxes, words and lines are React Flow nodes and edges at the places the C4
// layout computed, under the canvas's own minimap, zoom, toolbar, panel and walk-through.

export interface C4BoxData extends Record<string, unknown> {
  box: DBox;
  on: boolean;
  rel: boolean;
  hit: boolean;
  mark: StepMark | null;
  /** A folded boundary opens in place on a click; absent, a click pins its card instead. */
  canOpen: boolean;
}

export interface C4CaptionData extends Record<string, unknown> {
  caption: DCaption;
  onFold: ((group: string) => void) | null;
}

export interface C4BoundaryData extends Record<string, unknown> {
  boundary: NonNullable<Diagram["boundary"]>;
}

export interface C4LineData extends Record<string, unknown> {
  line: DLine;
  on: boolean;
  lit: boolean;
  dim: boolean;
}

const ends = (
  <>
    <Handle type="target" position={Position.Left} isConnectable={false} />
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </>
);

/** A folded boundary's card: who or what it stands for, each outside system with its integration state. */
function Members({ box }: { box: DBox }) {
  const members = box.members ?? [];
  return (
    <div className="grid gap-2" data-testid="c4-group-card">
      <div className="flex items-baseline gap-2">
        <b className="text-13-5 font-semibold">{box.lines.join(" ")}</b>
        <span className="text-12 text-muted">{box.kicker}</span>
      </div>
      <ul className="m-0 grid list-none p-0">
        {members.map((x) => (
          <li key={x.id} className="flex items-center gap-2 border-t border-line-subtle py-1.5 first:border-t-0" data-testid="c4-group-member">
            <span className="grid min-w-0 flex-1">
              <span className="text-13 font-medium">{x.name}</span>
              {x.owner ? <span className="truncate text-12 text-muted">{x.owner}</span> : null}
            </span>
            {x.state ? <IntegrationBadge state={x.state} mark={x.mark} /> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function C4Box({ data }: NodeProps & { data: C4BoxData }) {
  const { box: b } = data;
  const anchor = useRef<HTMLDivElement>(null);
  const card = useHoverCard();
  const group = Boolean(b.members?.length);
  const focal = b.kind === "focal";
  return (
    <>
      <div
        ref={anchor}
        className="wfc-c4"
        data-kind={b.kind}
        data-group={group}
        data-state={b.state ?? undefined}
        data-on={data.on}
        data-rel={data.rel}
        data-hit={data.hit}
        data-mark={data.mark ?? undefined}
        data-testid="c4-box"
        data-id={b.id}
        style={{ width: b.w, height: b.h, ["--mark" as string]: data.mark ? MARK_HUE[data.mark] : undefined }}
        title={group ? undefined : b.tip}
        {...(group ? card.trigger : {})}
        onClickCapture={() => {
          if (group && !data.canOpen) card.pinned ? card.close() : card.pin();
        }}
      >
        {ends}
        {b.kicker ? (
          <span className="wfc-c4-kick" style={{ fontSize: FONT.kicker }}>
            {b.kicker}
            {group && data.canOpen ? <ChevronDown size={12} aria-hidden /> : null}
          </span>
        ) : null}
        {b.lines.map((l) => (
          <span key={l} className="wfc-c4-title" style={{ fontSize: focal ? FONT.focal : FONT.title }}>
            {l}
          </span>
        ))}
      </div>
      {group ? (
        <Popover
          open={card.open}
          anchor={anchor}
          onDismiss={card.close}
          placement="right-start"
          role="dialog"
          aria-label={`${b.lines.join(" ")}: ${b.kicker}`}
          maxWidth={360}
          className="w-[320px] rounded-lg border border-line bg-surface px-3.5 py-3 shadow-lg"
          {...card.card}
        >
          <Members box={b} />
        </Popover>
      ) : null}
    </>
  );
}

function C4Caption({ data }: NodeProps & { data: C4CaptionData }) {
  const c = data.caption;
  const heading = c.tone === "heading";
  const size = heading ? FONT.heading : FONT.group;
  const fold = c.folds && data.onFold ? data.onFold : null;
  const text = (
    <span className="wfc-c4-cap" data-tone={c.tone} style={{ fontSize: size, maxWidth: c.maxWidth }}>
      {c.text}
    </span>
  );
  return (
    <div className="wfc-c4-caption" title={c.tip} style={{ height: size * 1.4 }}>
      {fold && c.folds ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="wfc-c4-fold nodrag nopan"
          title="Fold this boundary back into one box"
          onClick={(e) => {
            e.stopPropagation();
            fold(c.folds as string);
          }}
        >
          <ChevronUp size={12} aria-hidden />
          {text}
        </Button>
      ) : (
        text
      )}
    </div>
  );
}

function C4Boundary({ data }: NodeProps & { data: C4BoundaryData }) {
  const b = data.boundary;
  return (
    <div className="wfc-c4-boundary" style={{ width: b.w, height: b.h }} title={[b.title, b.tip].filter(Boolean).join("\n")} data-testid="c4-boundary">
      <span style={{ fontSize: FONT.boundary }}>{b.title}</span>
      <span style={{ fontSize: FONT.kicker }}>Software system</span>
    </div>
  );
}

const SHIFT: Record<DLine["anchor"], string> = { start: "0%", middle: "-50%", end: "-100%" };

function C4Line({ id, data, markerEnd, markerStart }: EdgeProps & { data: C4LineData }) {
  const l = data.line;
  const colour = data.on ? "var(--accent)" : l.colour;
  return (
    <>
      <BaseEdge
        id={id}
        path={l.d}
        markerEnd={l.arrowEnd ? markerEnd : undefined}
        markerStart={l.arrowStart ? markerStart : undefined}
        interactionWidth={12}
        style={{ stroke: colour, strokeWidth: data.on || data.lit ? 2.25 : 1.4, strokeDasharray: l.dash, opacity: data.dim ? 0.18 : 1 }}
      />
      {l.label ? (
        <EdgeLabelRenderer>
          <div
            className="wfc-c4-label nodrag nopan"
            data-edge={id}
            data-on={data.on}
            data-rel={!data.dim}
            title={l.tip}
            style={{ fontSize: FONT.label, transform: `translate(${SHIFT[l.anchor]}, -50%) translate(${l.at.x}px, ${l.at.y}px)` }}
          >
            {l.label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

export const C4_NODE_TYPES = { c4box: memo(C4Box), c4caption: memo(C4Caption), c4boundary: memo(C4Boundary) };
export const C4_EDGE_TYPES = { c4: memo(C4Line) };
