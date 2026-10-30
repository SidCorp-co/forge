
import type { WorkflowTemplate } from "@forge/contracts/workflow-templates";
import { useState } from "react";
import { Button, Input, SegmentedControl, TemplateIcon, Toggle, Icon } from "@/design";
import type { HealthLayer } from "../health";
import { useCopy } from "@/lib/i18n/interface-language";
import type { CanvasChanges, CanvasFocus, CanvasHealth } from "./workflow-canvas";
import type { Canvas } from "./model";
import { titleOf } from "./model";
import { DASH, edgeHue, hue } from "./style";

export type Language = "business" | "contract";

/**
 * The canvas's one row of controls (REQ-10 BC-16, REQ-12 BC-6): Walk through first, the first read;
 * then Open or Fold all, Health and the changes switch. Zoom decides how much a step shows, and the
 * page's Person / Developer switch decides whether the canvas speaks contract terms.
 */
export function ViewBar(p: {
  banded: boolean;
  allOpen: boolean;
  onToggleAll: () => void;
  onWalk: () => void;
  health?: CanvasHealth | null | undefined;
  changes?: CanvasChanges | null | undefined;
}) {
  const t = useCopy();
  return (
    <div className="wfc-float wfc-tl" role="toolbar" aria-label={t("workflows.canvas.view")} data-testid="canvas-toolbar">
      <WalkStart onWalk={p.onWalk} />
      {p.banded ? (
        <Button type="button" variant="ghost" size="sm" className="wfc-ib" onClick={p.onToggleAll} data-testid="toggle-all">
          {p.allOpen ? <Icon name="chevronUp" size={16} /> : <Icon name="chevronDown" size={16} />}
          <span className="wfc-t">{p.allOpen ? t("workflows.canvas.foldAll") : t("workflows.canvas.openAll")}</span>
        </Button>
      ) : null}
      {p.health ? <HealthBar health={p.health} /> : null}
      <ChangesBar changes={p.changes} />
    </div>
  );
}

/** Walk through: the first control of every design canvas. */
export function WalkStart({ onWalk }: { onWalk: () => void }) {
  const t = useCopy();
  return (
    <Button type="button" variant="ghost" size="sm" className="wfc-ib" data-go="true" onClick={onWalk} data-testid="walk-start-bar">
      <Icon name="play" size={16} />
      <span className="wfc-t">{t("workflows.canvas.walk")}</span>
    </Button>
  );
}

/** The switch that marks what changed since the approved revision, where the page offers it. */
export function ChangesBar({ changes }: { changes?: CanvasChanges | null | undefined }) {
  if (!changes) return null;
  return (
    <>
      <span className="wfc-sep" />
      <span className="inline-flex items-center gap-1.5 px-1 text-13 font-semibold" title={changes.title} data-testid="design-changes-toggle">
        <Toggle checked={changes.on} onChange={changes.onToggle} aria-label={changes.title} />
        {changes.label}
      </span>
    </>
  );
}

/** Focus mode (the canvas alone, filling the viewport; F to enter or leave), on the zoom bar. */
function FocusButton({ focus }: { focus: CanvasFocus }) {
  const t = useCopy();
  const label = focus.on ? t("workflows.canvas.focusExit") : t("workflows.canvas.focus");
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="wfc-ib"
      aria-pressed={focus.on}
      aria-label={label}
      title={focus.on ? t("workflows.canvas.focusExitShortcut") : t("workflows.canvas.focusShortcut")}
      onClick={focus.onToggle}
      data-testid="canvas-focus"
    >
      {focus.on ? <Icon name="shrink" size={16} /> : <Icon name="expand" size={16} />}
    </Button>
  );
}

const LAYERS: readonly HealthLayer[] = ["planned", "observed", "both"];

/** The Health overlay toggle and the Planned / Observed / Both layer switch; both kept in the page address (REQ-17 BC-15, BC-28). */
export function HealthBar({ health }: { health: CanvasHealth }) {
  const t = useCopy();
  return (
    <>
      <span className="wfc-sep" />
      <span className="inline-flex items-center gap-1.5 px-1 text-13 font-semibold" data-testid="health-toggle">
        <Toggle checked={health.on} onChange={health.onToggle} aria-label={t("workflows.canvas.healthOverlay")} />
        {t("workflows.col.health")}
      </span>
      {health.observed ? (
        <>
          <span className="wfc-sep" />
          <SegmentedControl<HealthLayer>
            value={health.layer}
            onChange={health.onLayer}
            options={LAYERS.map((value) => ({ value, label: t(`workflows.layer.${value}`) }))}
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
  focus?: CanvasFocus | null | undefined;
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
      <Button type="button" variant="ghost" size="sm" className="wfc-ib" title={t("workflows.canvas.fitShortcut")} aria-label={t("workflows.canvas.fit")} onClick={p.onFit}>
        <Icon name="maximize" size={16} />
      </Button>
      <span className="wfc-sep" />
      <Button type="button" variant="ghost" size="sm" className="wfc-ib" aria-pressed={p.minimap} title={t("workflows.canvas.minimap")} aria-label={t("workflows.canvas.minimap")} onClick={p.onMinimap}>
        <Icon name="map" size={16} />
      </Button>
      <Button type="button" variant="ghost" size="sm" className="wfc-ib" aria-pressed={p.legend} title={t("workflows.canvas.legend")} aria-label={t("workflows.canvas.legend")} onClick={p.onLegend}>
        <Icon name="help" size={16} />
      </Button>
      {p.focus ? <FocusButton focus={p.focus} /> : null}
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
      <span className="px-1.5 text-13 font-semibold text-muted">
        {at + 1} / {total}
      </span>
      <Button type="button" variant="ghost" size="sm" className="wfc-ib" data-go="true" aria-label={t("workflows.walk.nextStep")} onClick={() => onWalk(at + 1)}>
        <span className="wfc-t">{at === total - 1 ? t("workflows.walk.finish") : t("workflows.walk.next")}</span> {at === total - 1 ? "✓" : "›"}
      </Button>
      <Button type="button" variant="ghost" size="sm" className="wfc-ib" aria-label={t("workflows.walk.stop")} title={t("workflows.walk.stopShortcut")} onClick={onStop}>
        ✕
      </Button>
    </div>
  );
}
