"use client";

import type { ReactNode } from "react";
import { Button, IconButton, Kicker, SectionTitle } from "@/design";
import type { WorkflowStep } from "../types";
import { type Canvas, type CanvasEdge, edgeText, purposeOf, titleOf } from "./model";
import { TypeChip } from "./nodes";
import { WireframeThumb } from "./wireframe-thumb";

export type Selection = { step: string } | { edge: string } | null;

export interface PanelProps {
  canvas: Canvas;
  selection: Selection;
  walk: { order: string[]; at: number } | null;
  /** The decision the approver can take here, when there is one to take. */
  decision: ReactNode;
  onClose: () => void;
  onWalk: (at: number) => void;
  onStep: (id: string) => void;
  onEdge: (id: string) => void;
}

function Sec({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-3.5">
      <Kicker className="mb-1.5 block">{title}</Kicker>
      {children}
    </div>
  );
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  const shown = rows.filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (shown.length === 0) return null;
  return (
    <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-2.5 gap-y-1.5 text-13 max-sm:grid-cols-[90px_minmax(0,1fr)]">
      {shown.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-subtle">{k}</dt>
          <dd className="m-0 [overflow-wrap:anywhere]">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function List({ items, mono = false }: { items?: string[]; mono?: boolean }) {
  if (!items?.length) return null;
  return (
    <ul className={`m-0 grid gap-0.5 pl-4.5 text-13 ${mono ? "font-mono text-12" : ""}`}>
      {items.map((x) => (
        <li key={x}>{x}</li>
      ))}
    </ul>
  );
}

const close = (onClose: () => void) => (
  <IconButton icon="x" size="sm" type="button" onClick={onClose} aria-label="Close" />
);

function Rules({ step }: { step: WorkflowStep }) {
  const rows = step.node?.conditions;
  if (!rows?.length) return null;
  return (
    <ul className="m-0 grid gap-0.5 pl-4.5 text-13">
      {rows.map((r) => (
        <li key={`${r.when}>${r.result}`}>
          {r.when} → <b>{r.result}</b>
        </li>
      ))}
    </ul>
  );
}

/** What happens next, in the design's own words: each line out of the step and the condition it takes. */
function Next({ c, id, onStep }: { c: Canvas; id: string; onStep: (id: string) => void }) {
  const out = c.edges.filter((e) => e.from === id);
  if (out.length === 0) return <p className="m-0 text-14">The flow ends here.</p>;
  return (
    <ul className="m-0 grid gap-1 pl-4.5 text-14">
      {out.map((e) => {
        const to = c.steps.get(e.to);
        return (
          <li key={e.id}>
            {edgeText(e) ? (
              <>
                If <b>{edgeText(e)}</b> →{" "}
              </>
            ) : (
              "Then → "
            )}
            <Button type="button" variant="ghost" size="sm" className="h-auto p-0 font-semibold text-link hover:bg-transparent hover:underline" onClick={() => onStep(e.to)}>
              {to ? titleOf(to) : e.to}
            </Button>
            {e.kind.direction === "return" || e.kind.line !== "solid" ? <span className="text-subtle"> ({e.kind.label.toLowerCase()})</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

function Links({ c, id, onEdge }: { c: Canvas; id: string; onEdge: (id: string) => void }) {
  const link = (e: CanvasEdge, out: boolean) => {
    const other = c.steps.get(out ? e.to : e.from);
    return (
      <Button key={e.id} type="button" variant="secondary" size="sm" onClick={() => onEdge(e.id)} className="h-auto justify-start whitespace-normal rounded-md border-line-subtle bg-app px-2.5 py-1.5 text-left text-12-5 font-normal hover:border-line-strong">
        {out ? "→ " : "← "}
        {other ? titleOf(other) : out ? e.to : e.from}
        {edgeText(e) ? <span className="text-subtle"> · {edgeText(e)}</span> : null}
      </Button>
    );
  };
  const inn = c.edges.filter((e) => e.to === id);
  const out = c.edges.filter((e) => e.from === id);
  return (
    <>
      {inn.length ? (
        <Sec title="Comes from">
          <div className="grid gap-1">{inn.map((e) => link(e, false))}</div>
        </Sec>
      ) : null}
      {out.length ? (
        <Sec title="Leads to">
          <div className="grid gap-1">{out.map((e) => link(e, true))}</div>
        </Sec>
      ) : null}
    </>
  );
}

function StepPanel({ c, step, onEdge }: { c: Canvas; step: WorkflowStep; onEdge: (id: string) => void }) {
  const n = step.node;
  const band = c.bands.find((b) => b.steps.includes(step.id));
  return (
    <>
      <SectionTitle className="fg-h3 mb-1.5 mt-1">{titleOf(step)}</SectionTitle>
      <p className="mb-3 text-13-5 text-muted">{purposeOf(step)}</p>
      {n?.wireframe?.svg ? <WireframeThumb attachment={n.wireframe.svg} title={titleOf(step)} /> : null}
      <Facts
        rows={[
          ["Stage", band?.label ?? c.laneOf(step.id)],
          ["Owner", n?.owner],
          ["Deadline", n?.sla],
          ["Persona", n?.persona ? (c.doc as { personas?: { id: string; label: string }[] }).personas?.find((p) => p.id === n.persona)?.label ?? n.persona : null],
          ["Expected", n?.expectedOutcome],
          ["Trigger", n?.trigger],
          ["Validation", n?.validation],
          ["State", n?.variant],
          ["Event", n?.event ? <span key="event" className="font-mono">{n.event}</span> : null],
          ["Route", n?.route ? <span key="route" className="font-mono">{n.route}</span> : null],
          ["Channel", n?.channel],
          ["Carries", n?.payload?.join(", ")],
          ["Values", n?.values?.join(" · ")],
          ["Maps to", n?.mapsTo],
          ["Done once", n?.idempotency],
          [
            "Links to",
            n?.refs?.length ? (
              <span key="refs" className="font-mono">
                {n.refs.map((r) => `${r.flow}/${r.step}`).join(", ")}
              </span>
            ) : null,
          ],
          ["Design id", <span key="id" className="font-mono">{step.id}</span>],
        ]}
      />
      {n?.conditions?.length ? (
        <Sec title="Decisions">
          <Rules step={step} />
        </Sec>
      ) : null}
      {n?.tests?.length ? (
        <Sec title="Checked against">
          <List items={n.tests} />
        </Sec>
      ) : null}
      {n?.dataShown?.length ? (
        <Sec title="Shows">
          <List items={n.dataShown} />
        </Sec>
      ) : null}
      {n?.actions?.length ? (
        <Sec title="Offers">
          <List items={n.actions} />
        </Sec>
      ) : null}
      {n?.permissions?.length ? (
        <Sec title="May">
          <List items={n.permissions} />
        </Sec>
      ) : null}
      {n?.inputs?.length ? (
        <Sec title="Inputs">
          <List items={n.inputs} mono />
        </Sec>
      ) : null}
      {n?.outputs?.length ? (
        <Sec title="Outputs">
          <List items={n.outputs} mono />
        </Sec>
      ) : null}
      <Sec title="Contract">
        <p className="m-0 whitespace-pre-wrap text-13">{step.does}</p>
      </Sec>
      <Links c={c} id={step.id} onEdge={onEdge} />
    </>
  );
}

function EdgePanel({ c, edge, onStep }: { c: Canvas; edge: CanvasEdge; onStep: (id: string) => void }) {
  const k = edge.contract;
  const name = (id: string) => {
    const s = c.steps.get(id);
    return s ? titleOf(s) : id;
  };
  const mapping = Object.entries(k?.mapping ?? {});
  return (
    <>
      <div className="mt-1.5 grid gap-1">
        <Button size="sm" variant="secondary" onClick={() => onStep(edge.from)}>
          {name(edge.from)}
        </Button>
        <span className="text-center text-13 text-subtle">
          {edge.kind.direction === "return" ? "↺" : "↓"} {edgeText(edge) || edge.kind.label}
        </span>
        <Button size="sm" variant="secondary" onClick={() => onStep(edge.to)}>
          {name(edge.to)}
        </Button>
      </div>
      <Facts
        rows={[
          ["Kind", edge.kind.label],
          ["Re-evaluates", k?.reevaluates],
          ["Condition", k?.condition],
          ["Action", k?.action ? <span key="action" className="font-mono">{k.action}</span> : null],
          ["Sends", k?.payload?.join(", ")],
          ["Over", k?.protocol],
          ["On failure", k?.onFailure],
          ["Idempotency", k?.idempotency],
        ]}
      />
      <Sec title="Data passed along">
        {mapping.length ? (
          <Facts rows={mapping.map(([to, from]) => [to, <span key={to} className="font-mono">← {from}</span>])} />
        ) : (
          <p className="m-0 text-13 text-subtle">No mapping declared.</p>
        )}
      </Sec>
    </>
  );
}

export function DetailPanel(p: PanelProps) {
  const { canvas: c, selection, walk } = p;
  const stepId = selection && "step" in selection ? selection.step : null;
  const step = stepId ? c.steps.get(stepId) : undefined;
  const walking = walk && walk.at < walk.order.length && step && walk.order[walk.at] === step.id;
  let body: ReactNode = null;
  if (walk && walk.at >= walk.order.length) {
    body = (
      <>
        <div className="flex items-center justify-between">
          <span className="fg-overline">Walk-through finished</span>
          {close(p.onClose)}
        </div>
        <SectionTitle className="fg-h3 mb-1.5 mt-1">You have seen all {walk.order.length} steps</SectionTitle>
        <p className="mb-3 text-13-5 text-muted">{c.doc.summary}</p>
        {p.decision}
      </>
    );
  } else if (walking && step) {
    const last = walk.at === walk.order.length - 1;
    body = (
      <>
        <div className="flex items-center justify-between">
          <span className="fg-overline">
            Walk-through · {walk.at + 1} of {walk.order.length}
          </span>
          {close(p.onClose)}
        </div>
        <div className="my-1.5 h-1 overflow-hidden rounded-2 bg-sunken">
          <i className="block h-full rounded-2 bg-accent" style={{ width: `${((walk.at + 1) / walk.order.length) * 100}%` }} />
        </div>
        <div className="mt-2.5">
          <TypeChip type={c.typeOf(step.id)} />
        </div>
        <SectionTitle className="fg-h3 mb-1.5 mt-1">{titleOf(step)}</SectionTitle>
        <p className="mb-2.5 text-14 leading-relaxed-1-6">{purposeOf(step)}</p>
        {step.node?.owner ? (
          <p className="mb-2.5 text-14">
            <b>{step.node.owner}</b>
            {step.node.sla ? (
              <>
                {" "}
                · <b>{step.node.sla}</b>
              </>
            ) : null}
          </p>
        ) : null}
        {step.node?.conditions?.length ? (
          <Sec title="How it decides">
            <Rules step={step} />
          </Sec>
        ) : null}
        <Sec title="What happens next">
          <Next c={c} id={step.id} onStep={p.onStep} />
        </Sec>
        <div className="mt-4 flex gap-2">
          <Button className="flex-1" variant="secondary" disabled={walk.at === 0} onClick={() => p.onWalk(walk.at - 1)}>
            ‹ Back
          </Button>
          <Button className="flex-1" variant="primary" onClick={() => p.onWalk(walk.at + 1)}>
            {last ? "Finish ✓" : "Next ›"}
          </Button>
        </div>
      </>
    );
  } else if (step) {
    body = (
      <>
        <div className="flex items-center justify-between">
          <TypeChip type={c.typeOf(step.id)} />
          {close(p.onClose)}
        </div>
        <StepPanel c={c} step={step} onEdge={p.onEdge} />
      </>
    );
  } else if (selection && "edge" in selection) {
    const edge = c.edges.find((e) => e.id === selection.edge);
    body = edge ? (
      <>
        <div className="flex items-center justify-between">
          <span className="fg-overline">{edge.kind.label}</span>
          {close(p.onClose)}
        </div>
        <EdgePanel c={c} edge={edge} onStep={p.onStep} />
      </>
    ) : null;
  }
  // cm:why with nothing selected the panel is closed: the page's facts rail carries the design's summary and counts, and the canvas toolbar its walk-through
  if (!body) return null;
  return (
    <aside className="w-[370px] flex-none overflow-y-auto border-l border-line-subtle bg-surface px-4.5 pb-7 pt-4 max-lg:w-full max-lg:border-l-0 max-lg:border-t" aria-live="polite" data-testid="workflow-panel">
      {body}
    </aside>
  );
}
