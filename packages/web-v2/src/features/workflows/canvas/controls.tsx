"use client";

import type { WorkflowTemplate } from "@forge/contracts/workflow-templates";
import { ChevronDown, ChevronUp, CircleHelp, Maximize, Map as MapIcon, Play } from "lucide-react";
import { useState } from "react";
import { Button, Input, SegmentedControl, TemplateIcon } from "@/design";
import type { Canvas } from "./model";
import { titleOf } from "./model";
import { DASH, edgeHue, hue } from "./style";
import type { Lod } from "./view";

export type Language = "business" | "contract";

export function ViewBar(p: {
  language: Language;
  lod: Lod;
  banded: boolean;
  allOpen: boolean;
  onLanguage: (l: Language) => void;
  onLod: (l: Lod) => void;
  onToggleAll: () => void;
  onWalk: () => void;
}) {
  return (
    <div className="wfc-float wfc-tl" role="toolbar" aria-label="View">
      <SegmentedControl<Language>
        value={p.language}
        onChange={p.onLanguage}
        options={[
          { value: "business", label: "Business", title: "The design's business words on every card and line" },
          { value: "contract", label: "Contract", title: "Design ids, the data passed along and idempotency" },
        ]}
      />
      {p.banded ? (
        <>
          <span className="wfc-sep" />
          <span className="wfc-lod">
            <SegmentedControl<"0" | "1" | "2">
              value={String(p.lod) as "0" | "1" | "2"}
              onChange={(v) => p.onLod(Number(v) as Lod)}
              options={[
                { value: "0", label: "Stages", title: "Stages only — zoom out to get here" },
                { value: "1", label: "Steps", title: "Step titles — mid zoom" },
                { value: "2", label: "Detail", title: "Full cards — zoom in to get here" },
              ]}
            />
          </span>
          <Button type="button" variant="ghost" size="sm" className="wfc-ib" onClick={p.onToggleAll} title={p.allOpen ? "Fold every stage back to its summary" : "Open every stage to its steps"} data-testid="toggle-all">
            {p.allOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            <span className="wfc-t">{p.allOpen ? "Fold all" : "Open all"}</span>
          </Button>
        </>
      ) : null}
      <span className="wfc-sep" />
      <Button type="button" variant="ghost" size="sm" className="wfc-ib" data-go="true" onClick={p.onWalk} title="Step through the flow one step at a time" data-testid="walk-start-bar">
        <Play size={16} />
        <span className="wfc-t">Walk through</span>
      </Button>
    </div>
  );
}

export function SearchBox({ c, hits, query, onQuery, onPick }: { c: Canvas; hits: string[]; query: string; onQuery: (q: string) => void; onPick: (id: string) => void }) {
  const [cur, setCur] = useState(0);
  return (
    <div className="wfc-float wfc-tr">
      <Input
        className="wfc-search"
        variant="bare"
        icon="search"
        type="search"
        value={query}
        placeholder="Find a step, owner or rule"
        aria-label="Search the flow"
        autoComplete="off"
        data-testid="workflow-search"
        onChange={(e) => {
          setCur(0);
          onQuery(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (hits.length) setCur((cur + (e.key === "ArrowDown" ? 1 : -1) + hits.length) % hits.length);
          } else if (e.key === "Enter" && hits[cur]) onPick(hits[cur]);
          else if (e.key === "Escape") onQuery("");
        }}
      />
      {query.trim() ? (
        <ul className="wfc-results">
          {hits.length ? (
            hits.map((id, i) => {
              const s = c.steps.get(id);
              const t = c.typeOf(id);
              return (
                <li key={id}>
                  <Button type="button" variant="ghost" size="sm" data-cur={i === cur} style={{ ["--tc" as string]: hue(t.colour) }} onClick={() => onPick(id)}>
                    <TemplateIcon icon={t.icon} size={14} />
                    {s ? titleOf(s) : id}
                  </Button>
                </li>
              );
            })
          ) : (
            <li className="px-2 py-1.5 text-13 text-subtle">Nothing matches</li>
          )}
        </ul>
      ) : null}
    </div>
  );
}

export function ZoomBar(p: {
  zoom: number;
  minimap: boolean;
  legend: boolean;
  onZoom: (factor: number) => void;
  onReset: () => void;
  onFit: () => void;
  onMinimap: () => void;
  onLegend: () => void;
}) {
  return (
    <div className="wfc-float wfc-bl" role="toolbar" aria-label="Canvas">
      <Button type="button" variant="ghost" size="sm" className="wfc-ib" aria-label="Zoom out" title="Zoom out" onClick={() => p.onZoom(1 / 1.2)}>
        −
      </Button>
      <Button type="button" variant="ghost" size="sm" className="wfc-ib" title="Back to 100%" onClick={p.onReset} data-testid="zoom-pct">
        {Math.round(p.zoom * 100)}%
      </Button>
      <Button type="button" variant="ghost" size="sm" className="wfc-ib" aria-label="Zoom in" title="Zoom in" onClick={() => p.onZoom(1.2)}>
        +
      </Button>
      <Button type="button" variant="ghost" size="sm" className="wfc-ib" title="Fit the whole flow (F)" aria-label="Fit" onClick={p.onFit}>
        <Maximize size={16} />
      </Button>
      <span className="wfc-sep" />
      <Button type="button" variant="ghost" size="sm" className="wfc-ib" aria-pressed={p.minimap} title="Show or hide the minimap" aria-label="Minimap" onClick={p.onMinimap}>
        <MapIcon size={16} />
      </Button>
      <Button type="button" variant="ghost" size="sm" className="wfc-ib" aria-pressed={p.legend} title="What the colours and lines mean" aria-label="Legend" onClick={p.onLegend}>
        <CircleHelp size={16} />
      </Button>
    </div>
  );
}

/** The key, read from the template: its node types and its edge kinds, each with its tooltip. */
export function Legend({ template }: { template: WorkflowTemplate | null }) {
  if (!template) return null;
  return (
    <div className="wfc-float wfc-legend" data-testid="workflow-legend">
      {template.nodeTypes.map((t) => (
        <div key={t.id} title={t.tooltip} style={{ ["--tc" as string]: hue(t.colour) }}>
          <TemplateIcon icon={t.icon} size={15} />
          <span>{t.label}</span>
        </div>
      ))}
      {template.edgeKinds.map((k) => (
        <div key={k.id} title={k.tooltip} style={{ ["--tc" as string]: edgeHue(k) }}>
          <svg width="22" height="10" aria-hidden>
            <path d="M1 5h20" stroke="currentColor" strokeWidth="2" strokeDasharray={DASH[k.line]} />
          </svg>
          <span>{k.label}</span>
        </div>
      ))}
    </div>
  );
}

export function WalkBar({ at, total, onWalk, onStop }: { at: number; total: number; onWalk: (at: number) => void; onStop: () => void }) {
  return (
    <div className="wfc-float wfc-bc" data-testid="walk-bar">
      <Button type="button" variant="ghost" size="sm" className="wfc-ib" disabled={at === 0} aria-label="Previous step" onClick={() => onWalk(at - 1)}>
        ‹ <span className="wfc-t">Back</span>
      </Button>
      <span className="px-1.5 text-12-5 font-semibold text-muted">
        {at + 1} / {total}
      </span>
      <Button type="button" variant="ghost" size="sm" className="wfc-ib" data-go="true" aria-label="Next step" onClick={() => onWalk(at + 1)}>
        <span className="wfc-t">{at === total - 1 ? "Finish" : "Next"}</span> {at === total - 1 ? "✓" : "›"}
      </Button>
      <Button type="button" variant="ghost" size="sm" className="wfc-ib" aria-label="Stop walking" title="Stop (Esc)" onClick={onStop}>
        ✕
      </Button>
    </div>
  );
}
