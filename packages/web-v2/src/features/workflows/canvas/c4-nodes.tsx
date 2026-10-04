"use client";

import { BaseEdge, type EdgeProps, EdgeLabelRenderer, Handle, type NodeProps, Position } from "@xyflow/react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { memo, useRef } from "react";
import { Button, Popover, useHoverCard } from "@/design";
import { type DBox, type DFrame, type DLine, FONT } from "../c4/layout";
import { FOCAL } from "../c4/view";
import { IntegrationBadge } from "../components/workflow-parts";
import type { StepMark } from "../design-diff";
import { MARK_HUE } from "./style";

// A C4 diagram is drawn by the same canvas as every other design: its boxes, frames and lines are
// React Flow nodes and edges at the places the C4 layout computed.

export interface C4BoxData extends Record<string, unknown> {
  box: DBox;
  on: boolean;
  rel: boolean;
  hit: boolean;
  mark: StepMark | null;
  /** A folded boundary opens in place on a click; absent, a click pins its card instead. */
  canOpen: boolean;
}

export interface C4FrameData extends Record<string, unknown> {
  frame: DFrame;
  onFold: ((id: string) => void) | null;
}

export interface C4LineData extends Record<string, unknown> {
  line: DLine;
  /** Every relationship the line stands for, one per row, for its hover card. */
  rows: string[];
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

const countWord = (b: DBox) => {
  const n = b.node.count ?? 0;
  if (b.node.kind === "focal") return `${n} ${n === 1 ? "part" : "parts"} inside`;
  const people = b.node.members.every((m) => m.kind === "person");
  return people ? `${n} ${n === 1 ? "person" : "people"}` : `${n} ${n === 1 ? "system" : "systems"}`;
};

/** A folded boundary's card: who or what it stands for, each outside system with its integration state. */
function Members({ box }: { box: DBox }) {
  return (
    <div className="grid gap-2" data-testid="c4-group-card">
      <div className="flex items-baseline gap-2">
        <b className="text-13-5 font-semibold">{box.node.name}</b>
        <span className="text-12 text-muted">{countWord(box)}</span>
      </div>
      <ul className="m-0 grid list-none p-0">
        {box.node.members.map((x) => (
          <li key={x.id} className="flex items-center gap-2 border-t border-line-subtle py-1.5 first:border-t-0" data-testid="c4-group-member">
            <span className="grid min-w-0 flex-1">
              <span className="text-13 font-medium">{x.name}</span>
              {x.owner ? <span className="truncate text-12 text-muted">{x.owner}</span> : null}
            </span>
            {x.integration ? <IntegrationBadge state={x.integration} mark={x.mark} /> : null}
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
  const group = b.node.kind === "group";
  const focal = b.node.kind === "focal";
  return (
    <>
      <div
        ref={anchor}
        className="wfc-c4"
        data-kind={b.node.kind}
        data-state={b.node.node?.integration ?? undefined}
        data-on={data.on}
        data-rel={data.rel}
        data-hit={data.hit}
        data-mark={data.mark ?? undefined}
        data-testid="c4-box"
        data-id={b.node.id}
        style={{ width: b.w, height: b.h, ["--mark" as string]: data.mark ? MARK_HUE[data.mark] : undefined }}
        title={group ? undefined : b.node.tip}
        {...(group ? card.trigger : {})}
        onClickCapture={() => {
          if (group && !data.canOpen) card.pinned ? card.close() : card.pin();
        }}
      >
        {ends}
        {b.node.count !== null ? (
          <span className="wfc-c4-chip" style={{ fontSize: FONT.chip }} title={countWord(b)} data-testid="c4-count">
            {b.node.count}
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
          aria-label={`${b.node.name}: ${countWord(b)}`}
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

function C4Frame({ data }: NodeProps & { data: C4FrameData }) {
  const f = data.frame;
  const fold = f.frame.folds && data.onFold ? data.onFold : null;
  const label = (
    <span className="wfc-c4-frame-label" style={{ fontSize: FONT.frame }}>
      {f.frame.label}
    </span>
  );
  return (
    <div className="wfc-c4-frame" data-focal={f.frame.id === FOCAL} style={{ width: f.w, height: f.h }} title={[f.frame.label, f.frame.tip].filter(Boolean).join("\n")} data-testid="c4-frame">
      {fold ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="wfc-c4-fold nodrag nopan"
          title="Fold this boundary back into one box"
          onClick={(e) => {
            e.stopPropagation();
            fold(f.frame.id);
          }}
        >
          <ChevronUp size={12} aria-hidden />
          {label}
        </Button>
      ) : (
        label
      )}
    </div>
  );
}

function C4Line({ id, data, markerEnd, markerStart }: EdgeProps & { data: C4LineData }) {
  const l = data.line;
  const anchor = useRef<HTMLDivElement>(null);
  const card = useHoverCard();
  const colour = data.on ? "var(--accent)" : l.colour;
  const label = l.label;
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
      {label ? (
        <EdgeLabelRenderer>
          <div
            ref={anchor}
            className="wfc-c4-label nodrag nopan"
            data-edge={id}
            data-on={data.on}
            data-rel={!data.dim}
            style={{ fontSize: FONT.label, width: label.w, height: label.h, transform: `translate(${label.x}px, ${label.y}px)` }}
            {...card.trigger}
          >
            {label.lines.map((t, i) => (
              <span key={t} className="wfc-c4-label-line">
                {t}
                {label.more && !label.chipBelow && i === label.lines.length - 1 ? <span className="wfc-c4-more">+{label.more} more</span> : null}
              </span>
            ))}
            {label.more && label.chipBelow ? (
              <span className="wfc-c4-label-line">
                <span className="wfc-c4-more">+{label.more} more</span>
              </span>
            ) : null}
          </div>
          <Popover open={card.open} anchor={anchor} onDismiss={card.close} placement="bottom-start" role="tooltip" maxWidth={420} className="rounded-lg border border-line bg-surface px-3 py-2 shadow-lg" {...card.card}>
            <ul className="m-0 grid list-none gap-1 p-0" data-testid="c4-line-card">
              {data.rows.map((r) => (
                <li key={r} className="text-13 leading-relaxed-1-6">
                  {r}
                </li>
              ))}
            </ul>
          </Popover>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

export const C4_NODE_TYPES = { c4box: memo(C4Box), c4frame: memo(C4Frame) };
export const C4_EDGE_TYPES = { c4: memo(C4Line) };
