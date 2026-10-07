"use client";

import type { WorkflowTemplate } from "@forge/contracts/workflow-templates";
import { ChevronDown, ChevronUp, CircleHelp, Maximize, Map as MapIcon, Play } from "lucide-react";
import { useState } from "react";
import { Button, Input, SegmentedControl, TemplateIcon, Toggle } from "@/design";
import type { HealthLayer } from "../health";
import { useCopy } from "@/lib/i18n/interface-language";
import type { CanvasHealth } from "./workflow-canvas";
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
  health?: CanvasHealth | null | undefined;
}) {
  const t = useCopy();
  return (
    <div className="wfc-float wfc-tl" role="toolbar" aria-label={t("workflows.canvas.view")}>
      <SegmentedControl<Language>
        value={p.language}
        onChange={p.onLanguage}
        options={[
          { value: "business", label: t("workflows.canvas.business"), title: t("workflows.canvas.businessHint") },
          { value: "contract", label: t("workflows.panel.contract"), title: t("workflows.canvas.contractHint") },
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
                { value: "0", label: t("workflows.canvas.stages"), title: t("workflows.canvas.stagesHint") },
                { value: "1", label: t("workflows.tab.steps"), title: t("workflows.canvas.stepsHint") },
                { value: "2", label: t("workflows.canvas.detail"), title: t("workflows.canvas.detailHint") },
              ]}
            />
          </span>
          <Button type="button" variant="ghost" size="sm" className="wfc-ib" onClick={p.onToggleAll} title={p.allOpen ? t("workflows.canvas.foldAllHint") : t("workflows.canvas.openAllHint")} data-testid="toggle-all">
            {p.allOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            <span className="wfc-t">{p.allOpen ? t("workflows.canvas.foldAll") : t("workflows.canvas.openAll")}</span>
          </Button>
        </>
      ) : null}
      <span className="wfc-sep" />
      <Button type="button" variant="ghost" size="sm" className="wfc-ib" data-go="true" onClick={p.onWalk} title={t("workflows.canvas.walkHint")} data-testid="walk-start-bar">
        <Play size={16} />
        <span className="wfc-t">{t("workflows.canvas.walk")}</span>
      </Button>
      {p.health ? <HealthBar health={p.health} /> : null}
    </div>
  );
}

const LAYERS: readonly HealthLayer[] = ["planned", "observed", "both"];

/** The Health overlay toggle and the Planned / Observed / Both layer switch; both kept in the page address (REQ-17 BC-15, BC-28). */
export function HealthBar({ health }: { health: CanvasHealth }) {
  const t = useCopy();
  return (
    <>
      <span className="wfc-sep" />
      <span className="inline-flex items-center gap-1.5 px-1 text-12-5 font-semibold" title={t("workflows.canvas.healthHint")} data-testid="health-toggle">
        <Toggle checked={health.on} onChange={health.onToggle} aria-label={t("workflows.canvas.healthOverlay")} />
        {t("workflows.col.health")}
      </span>
      {health.observed ? (
        <>
          <span className="wfc-sep" />
          <SegmentedControl<HealthLayer>
            value={health.layer}
            onChange={health.onLayer}
            options={LAYERS.map((value) => ({ value, label: t(`workflows.layer.${value}`), title: t(`workflows.layer.${value}.hint`) }))}
          />
        </>
      ) : null}
    </>
  );
}

export function SearchBox({ c, hits, query, onQuery, onPick }: { c: Canvas; hits: string[]; query: string; onQuery: (q: string) => void; onPick: (id: string) => void }) {
  const t = useCopy();
  const [cur, setCur] = useState(0);
  return (
    <div className="wfc-float wfc-tr">
      <Input
        className="wfc-search"
        variant="bare"
        icon="search"
        type="search"
        value={query}
        placeholder={t("workflows.canvas.searchPlaceholder")}
        aria-label={t("workflows.canvas.searchLabel")}
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
            <li className="px-2 py-1.5 text-13 text-subtle">{t("workflows.canvas.nothingMatches")}</li>
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
  const t = useCopy();
  return (
    <div className="wfc-float wfc-bl" role="toolbar" aria-label={t("workflows.canvas.canvas")}>
      <Button type="button" variant="ghost" size="sm" className="wfc-ib" aria-label={t("workflows.canvas.zoomOut")} title={t("workflows.canvas.zoomOut")} onClick={() => p.onZoom(1 / 1.2)}>
        −
      </Button>
      <Button type="button" variant="ghost" size="sm" className="wfc-ib" title={t("workflows.canvas.zoomReset")} onClick={p.onReset} data-testid="zoom-pct">
        {Math.round(p.zoom * 100)}%
      </Button>
      <Button type="button" variant="ghost" size="sm" className="wfc-ib" aria-label={t("workflows.canvas.zoomIn")} title={t("workflows.canvas.zoomIn")} onClick={() => p.onZoom(1.2)}>
        +
      </Button>
      <Button type="button" variant="ghost" size="sm" className="wfc-ib" title={t("workflows.canvas.fitHint")} aria-label={t("workflows.canvas.fit")} onClick={p.onFit}>
        <Maximize size={16} />
      </Button>
      <span className="wfc-sep" />
      <Button type="button" variant="ghost" size="sm" className="wfc-ib" aria-pressed={p.minimap} title={t("workflows.canvas.minimapHint")} aria-label={t("workflows.canvas.minimap")} onClick={p.onMinimap}>
        <MapIcon size={16} />
      </Button>
      <Button type="button" variant="ghost" size="sm" className="wfc-ib" aria-pressed={p.legend} title={t("workflows.canvas.legendHint")} aria-label={t("workflows.canvas.legend")} onClick={p.onLegend}>
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
  const t = useCopy();
  return (
    <div className="wfc-float wfc-bc" data-testid="walk-bar">
      <Button type="button" variant="ghost" size="sm" className="wfc-ib" disabled={at === 0} aria-label={t("workflows.walk.previousStep")} onClick={() => onWalk(at - 1)}>
        ‹ <span className="wfc-t">{t("workflows.walk.back")}</span>
      </Button>
      <span className="px-1.5 text-12-5 font-semibold text-muted">
        {at + 1} / {total}
      </span>
      <Button type="button" variant="ghost" size="sm" className="wfc-ib" data-go="true" aria-label={t("workflows.walk.nextStep")} onClick={() => onWalk(at + 1)}>
        <span className="wfc-t">{at === total - 1 ? t("workflows.walk.finish") : t("workflows.walk.next")}</span> {at === total - 1 ? "✓" : "›"}
      </Button>
      <Button type="button" variant="ghost" size="sm" className="wfc-ib" aria-label={t("workflows.walk.stop")} title={t("workflows.walk.stopHint")} onClick={onStop}>
        ✕
      </Button>
    </div>
  );
}
