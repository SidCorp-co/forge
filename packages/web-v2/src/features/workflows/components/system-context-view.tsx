"use client";

import type { WorkflowTemplate } from "@forge/contracts/workflow-templates";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ProjectLoader, SegmentedControl } from "@/design";
import { useQueryParam } from "@/lib/utils/use-query-param";
import { walkOrder } from "../canvas/model";
import { DetailPanel, type Selection } from "../canvas/panel";
import { hue, tint } from "../canvas/style";
import { layoutContainers } from "../c4/container-layout";
import { layoutContext } from "../c4/context-layout";
import { C4Diagram } from "../c4/diagram";
import type { DBox, Diagram, DLine } from "../c4/geometry";
import { FOCAL, readC4 } from "../c4/model";
import type { DesignDiff } from "../design-diff";
import type { WorkflowBody } from "../types";

type Level = "context" | "containers";

const LEVELS = [
  { value: "context" as const, label: "Context", title: "C4 level 1: the system as one box, the people who use it and the systems it talks to" },
  { value: "containers" as const, label: "Containers", title: "C4 level 2: what runs inside the system, and who and what each part talks to" },
];

function Key() {
  const swatch = (colour: string, radius: number) => (
    <i aria-hidden className="inline-block h-3 w-4 border" style={{ borderColor: hue(colour), background: tint(colour, 10, "var(--bg-surface)"), borderRadius: radius }} />
  );
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-12 text-muted max-md:hidden" data-testid="c4-key">
      <span className="inline-flex items-center gap-1.5">{swatch("orange", 6)}Person</span>
      <span className="inline-flex items-center gap-1.5">{swatch("blue", 2)}Our system</span>
      <span className="inline-flex items-center gap-1.5">{swatch("slate", 2)}External system</span>
      <span className="inline-flex items-center gap-1.5">
        <svg aria-hidden width="22" height="8">
          <line x1="0" y1="4" x2="22" y2="4" stroke={hue("teal")} strokeWidth="1.5" strokeDasharray="2 4" />
        </svg>
        Reads
      </span>
      <span className="inline-flex items-center gap-1.5">
        <svg aria-hidden width="22" height="8">
          <line x1="0" y1="4" x2="22" y2="4" stroke={hue("amber")} strokeWidth="1.5" strokeDasharray="6 4" />
        </svg>
        Writes
      </span>
    </span>
  );
}

/** The diagram scaled to fit its box on open, with zoom steps that scroll rather than crop. */
function Fitted({ diagram, children }: { diagram: Diagram; children: (style: React.CSSProperties) => ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(1);
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setFit(Math.min((el.clientWidth - 32) / diagram.width, (el.clientHeight - 32) / diagram.height));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [diagram]);
  // A new level opens fitted, never part-way through the last one's zoom.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the reset is keyed to the diagram changing
  useEffect(() => setZoom(1), [diagram]);
  const k = Math.max(0.1, fit * zoom);
  return (
    <div className="relative min-h-0 flex-1">
      <div ref={box} className="absolute inset-0 overflow-auto" data-testid="c4-viewport" data-zoom={zoom}>
        <div className="flex min-h-full min-w-full items-center justify-center p-4" style={{ width: diagram.width * k + 32, height: diagram.height * k + 32 }}>
          {children({ width: diagram.width * k, height: diagram.height * k, flex: "none" })}
        </div>
      </div>
      <span className="absolute bottom-3 left-3 flex items-center gap-0.5 rounded-md border border-line-subtle bg-surface p-0.5">
        <button type="button" className="h-7 w-7 rounded-sm text-15 font-semibold text-muted hover:bg-hover hover:text-fg" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.5, z / 1.25))}>
          −
        </button>
        <button type="button" className="h-7 rounded-sm px-2 text-12 font-semibold text-muted hover:bg-hover hover:text-fg" onClick={() => setZoom(1)} data-testid="c4-fit">
          Fit
        </button>
        <button type="button" className="h-7 w-7 rounded-sm text-15 font-semibold text-muted hover:bg-hover hover:text-fg" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(4, z * 1.25))}>
          +
        </button>
      </span>
    </div>
  );
}

export interface SystemContextViewProps {
  doc: Pick<WorkflowBody, "title" | "summary" | "kind" | "steps" | "edges" | "flow" | "lanes" | "personas">;
  template: WorkflowTemplate | null;
  /** The approver's Approve / Return, shown at the end of a walk-through. */
  decision?: ReactNode;
  diff?: DesignDiff | null;
}

/**
 * A system-context design read as C4: Context draws the system as one box between its people and the
 * systems around it; Containers opens the box. Both fit the view on open.
 */
export function SystemContextView({ doc, template, decision, diff = null }: SystemContextViewProps) {
  const m = useMemo(() => readC4(doc, template), [doc, template]);
  const [param, setParam] = useQueryParam("level");
  const level: Level = param === "containers" ? "containers" : "context";
  const context = useMemo(() => layoutContext(m), [m]);
  const [containers, setContainers] = useState<Diagram | null>(null);
  useEffect(() => {
    let live = true;
    void layoutContainers(m).then((d) => {
      if (live) setContainers(d);
    });
    return () => {
      live = false;
    };
  }, [m]);
  const order = useMemo(() => walkOrder(m.canvas), [m]);
  const [selection, setSelection] = useState<Selection>(null);
  const [walk, setWalk] = useState<number | null>(null);

  const diagram = level === "context" ? context : containers;
  const step = selection && "step" in selection ? selection.step : null;
  const edge = selection && "edge" in selection ? selection.edge : null;
  const lit = useMemo(() => {
    const s = new Set<string>(step ? [step] : []);
    if (step && level === "context" && m.focal?.parts.some((p) => p.id === step)) s.add(FOCAL);
    return s;
  }, [step, level, m]);

  const walkTo = (i: number) => {
    if (i < 0) return;
    if (i >= order.length) {
      setWalk(order.length);
      setSelection(null);
      return;
    }
    setWalk(i);
    setSelection({ step: order[i] as string });
  };
  const stop = () => {
    setWalk(null);
    setSelection(null);
  };
  const onBox = (b: DBox) => {
    if (b.step) setSelection({ step: b.step });
    else setParam("containers");
  };
  const onLine = (l: DLine) => {
    if (l.edge) setSelection({ edge: l.edge });
  };
  const name = m.focal?.title ?? doc.title;

  return (
    <div className="flex min-h-0 flex-1 max-lg:flex-col lg:[contain:size]" data-testid="system-context-view" data-level={level}>
      <div className="flex min-w-0 flex-1 flex-col bg-app max-lg:h-[72vh] max-lg:flex-none">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line-subtle px-4 py-2">
          <SegmentedControl options={LEVELS} value={level} onChange={(v) => setParam(v === "context" ? null : v)} />
          <span className="min-w-0 truncate text-13 font-semibold" data-testid="c4-title">
            {level === "context" ? `System context of ${name}` : `Containers of ${name}`}
          </span>
          <span className="ml-auto">
            <Key />
          </span>
        </div>
        {diagram ? (
          <Fitted diagram={diagram}>
            {(style) => (
              <C4Diagram
                diagram={diagram}
                title={level === "context" ? `System context of ${name}` : `Containers of ${name}`}
                selected={lit}
                selectedLine={edge}
                marks={diff?.steps ?? null}
                onBox={onBox}
                onLine={onLine}
                halo="var(--bg-app)"
                className="block"
                style={style}
              />
            )}
          </Fitted>
        ) : (
          <div className="grid flex-1 place-items-center">
            {level === "containers" ? <ProjectLoader label="laying out containers…" /> : <p className="text-13 text-muted">This design names no system, so it has no context to draw.</p>}
          </div>
        )}
      </div>
      <DetailPanel
        canvas={m.canvas}
        selection={selection}
        walk={walk === null ? null : { order, at: walk }}
        decision={decision}
        onClose={() => (walk !== null ? stop() : setSelection(null))}
        onWalk={walkTo}
        onStep={(id) => setSelection({ step: id })}
        onEdge={(id) => setSelection({ edge: id })}
      />
    </div>
  );
}
