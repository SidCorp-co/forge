"use client";

import { type CSSProperties, useId } from "react";
import { hue, MARK_HUE, tint } from "../canvas/style";
import type { StepMark } from "../design-diff";
import { type DBox, type DCaption, type Diagram, type DLine, LABEL_SIZE, textWidth, TITLE_SIZE } from "./geometry";

const LOOK: Record<DBox["kind"], { fill: string; stroke: string; width: number; radius: number }> = {
  person: { fill: tint("orange", 9, "var(--bg-surface)"), stroke: hue("orange"), width: 1.25, radius: 14 },
  system: { fill: tint("slate", 8, "var(--bg-surface)"), stroke: hue("slate"), width: 1.25, radius: 5 },
  container: { fill: tint("blue", 7, "var(--bg-surface)"), stroke: hue("blue"), width: 1.25, radius: 5 },
  focal: { fill: tint("blue", 14, "var(--bg-surface)"), stroke: hue("blue"), width: 2.25, radius: 8 },
};

function clip(text: string, width: number, size: number): string {
  if (textWidth(text, size) <= width) return text;
  let t = text;
  while (t.length > 1 && textWidth(`${t}…`, size) > width) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

function Box({ b, on, mark, onPick }: { b: DBox; on: boolean; mark: StepMark | null; onPick?: (b: DBox) => void }) {
  const look = LOOK[b.kind];
  const focal = b.kind === "focal";
  const size = focal ? 15 : TITLE_SIZE;
  const lead = size * 1.3;
  const kick = b.kicker ? 15 : 0;
  const top = b.y + b.h / 2 - ((b.lines.length - 1) * lead) / 2 + size * 0.35 + kick / 2;
  const body = (
    <>
      <title>{b.tip}</title>
      <rect
        x={b.x}
        y={b.y}
        width={b.w}
        height={b.h}
        rx={look.radius}
        fill={look.fill}
        stroke={on ? "var(--accent)" : mark ? MARK_HUE[mark] : look.stroke}
        strokeWidth={on ? 2.75 : mark ? 2.5 : look.width}
        strokeDasharray={mark === "removed" ? "5 4" : undefined}
        opacity={mark === "removed" ? 0.7 : 1}
      />
      {b.kicker ? (
        <text x={b.x + b.w / 2} y={top - lead / 2 - kick + 2} textAnchor="middle" fontSize={10.5} fontWeight={600} fill="var(--fg-muted)">
          {b.kicker}
        </text>
      ) : null}
      {b.lines.map((l, i) => (
        <text key={l} x={b.x + b.w / 2} y={top + i * lead} textAnchor="middle" fontSize={size} fontWeight={focal ? 700 : 600} fill="var(--fg-default)">
          {l}
        </text>
      ))}
    </>
  );
  const data = { "data-testid": "c4-box", "data-id": b.id, "data-kind": b.kind, "data-mark": mark ?? undefined };
  if (!onPick) return <g {...data}>{body}</g>;
  return (
    // biome-ignore lint/a11y/useSemanticElements: an SVG group cannot be a <button>; it takes the role and key handling instead
    <g
      role="button"
      tabIndex={0}
      aria-label={b.lines.join(" ")}
      onClick={() => onPick(b)}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onPick(b)}
      style={{ cursor: "pointer" }}
      {...data}
    >
      {body}
    </g>
  );
}

function Line({ l, marker, on, onPick }: { l: DLine; marker: (colour: string) => string; on: boolean; onPick?: (l: DLine) => void }) {
  const colour = on ? "var(--accent)" : l.colour;
  const head = `url(#${marker(colour)})`;
  const body = (
    <>
      <title>{l.tip}</title>
      <path d={l.d} fill="none" stroke="transparent" strokeWidth={12} />
      <path
        d={l.d}
        fill="none"
        stroke={colour}
        strokeWidth={on ? 2.25 : 1.4}
        strokeDasharray={l.dash}
        markerEnd={l.arrowEnd ? head : undefined}
        markerStart={l.arrowStart ? head : undefined}
      />
    </>
  );
  const data = { "data-testid": "c4-line", "data-id": l.id };
  if (!onPick) return <g {...data}>{body}</g>;
  return (
    // biome-ignore lint/a11y/useSemanticElements: an SVG group cannot be a <button>; it takes the role and key handling instead
    <g
      role="button"
      tabIndex={-1}
      aria-label={l.tip}
      onClick={() => onPick(l)}
      onKeyDown={(e) => e.key === "Enter" && onPick(l)}
      style={{ cursor: "pointer" }}
      {...data}
    >
      {body}
    </g>
  );
}

function Label({ l }: { l: DLine }) {
  if (!l.label) return null;
  return (
    <text
      x={l.at.x}
      y={l.at.y + LABEL_SIZE * 0.35}
      textAnchor={l.anchor}
      fontSize={LABEL_SIZE}
      fontWeight={500}
      fill="var(--fg-muted)"
      stroke="var(--c4-halo)"
      strokeWidth={4}
      strokeLinejoin="round"
      paintOrder="stroke"
      pointerEvents="none"
    >
      {l.label}
    </text>
  );
}

function Caption({ c }: { c: DCaption }) {
  const heading = c.tone === "heading";
  const size = heading ? 12.5 : 11;
  return (
    <text
      x={c.x}
      y={c.y}
      textAnchor={c.anchor}
      fontSize={size}
      fontWeight={heading ? 700 : 600}
      fill={heading ? "var(--fg-default)" : "var(--fg-subtle)"}
    >
      {c.tip ? <title>{c.tip}</title> : null}
      {clip(c.text, c.maxWidth, size)}
    </text>
  );
}

export interface C4DiagramProps {
  diagram: Diagram;
  /** Steps lit as selected; a step inside the system lights the system box on Context. */
  selected?: ReadonlySet<string>;
  selectedLine?: string | null;
  /** Steps added, changed or removed since the approved revision. */
  marks?: ReadonlyMap<string, StepMark> | null;
  onBox?: (b: DBox) => void;
  onLine?: (l: DLine) => void;
  className?: string;
  style?: CSSProperties;
  /** The page colour behind the diagram, so labels sit on a matching halo. */
  halo?: string;
  title: string;
}

/** A C4 diagram drawn as one SVG at its own size; the caller decides how it is scaled into view. */
export function C4Diagram({ diagram: d, selected, selectedLine = null, marks = null, onBox, onLine, className, style, halo = "var(--bg-surface)", title }: C4DiagramProps) {
  const base = `c4a${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  // One arrowhead per line colour: SVG's context-stroke is not drawn by every browser.
  const colours = [...new Set([...d.lines.map((l) => l.colour), "var(--accent)"])];
  const marker = (colour: string) => `${base}-${colours.indexOf(colour)}`;
  const b = d.boundary;
  return (
    <svg
      viewBox={`0 0 ${Math.ceil(d.width)} ${Math.ceil(d.height)}`}
      className={className}
      role="img"
      aria-label={title}
      style={{ ...style, ["--c4-halo" as string]: halo, fontFamily: "inherit" }}
      data-testid="c4-diagram"
      data-level={d.level}
    >
      <defs>
        {colours.map((c) => (
          <marker key={c} id={marker(c)} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill={c} />
          </marker>
        ))}
      </defs>
      {b ? (
        <g data-testid="c4-boundary">
          <title>{[b.title, b.tip].filter(Boolean).join("\n")}</title>
          <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={10} fill={tint("blue", 4, "transparent")} stroke={hue("blue")} strokeWidth={1.5} strokeDasharray="7 5" />
          <text x={b.x + 16} y={b.y + 24} fontSize={14} fontWeight={700} fill="var(--fg-default)">
            {clip(b.title, b.w - 150, 14)}
          </text>
          <text x={b.x + b.w - 16} y={b.y + 24} textAnchor="end" fontSize={11} fontWeight={600} fill="var(--fg-muted)">
            Software system
          </text>
        </g>
      ) : null}
      {d.captions.map((c) => (
        <Caption key={`${c.text}@${c.x},${c.y}`} c={c} />
      ))}
      {d.lines.map((l) => (
        <Line key={l.id} l={l} marker={marker} on={selectedLine === l.id || selectedLine === l.edge} onPick={onLine} />
      ))}
      {d.boxes.map((x) => (
        <Box
          key={x.id}
          b={x}
          on={Boolean(selected && (x.step ? selected.has(x.step) : selected.has(x.id)))}
          mark={x.step ? (marks?.get(x.step) ?? null) : null}
          onPick={onBox}
        />
      ))}
      {d.lines.map((l) => (
        <Label key={l.id} l={l} />
      ))}
    </svg>
  );
}
