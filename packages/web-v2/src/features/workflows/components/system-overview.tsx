"use client";

import type { WorkflowTemplate } from "@forge/contracts/workflow-templates";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Icon, Tooltip } from "@/design";
import { cn } from "@/lib/utils/cn";
import { layoutContext } from "../c4/context-layout";
import { C4Diagram } from "../c4/diagram";
import { type C4Model, FOCAL, relationWords, shortLabel } from "../c4/model";
import { type SystemOverview, systemOverview } from "../catalogue";
import { workflowHref } from "../routes";
import type { WorkflowRecord } from "../types";
import { DesignPill } from "./workflow-parts";

/** Context as a list, for a phone: who uses the system, the system, what it talks to, each with its one line. */
function ContextStack({ m }: { m: C4Model }) {
  const words = (id: string) => {
    const r = m.relations.find((x) => (x.from === id && x.to === FOCAL) || (x.to === id && x.from === FOCAL));
    return r ? shortLabel(relationWords(r), 34) : null;
  };
  const row = (id: string, title: string, owner: string | null) => (
    <li key={id} className="grid gap-0.5 border-b border-line-subtle py-2 last:border-b-0">
      <span className="text-13-5 font-semibold">{shortLabel(title, 48)}</span>
      {words(id) ? <span className="text-12-5 text-muted">{words(id)}</span> : null}
      {owner ? <span className="text-12 text-subtle">{owner}</span> : null}
    </li>
  );
  return (
    <div className="grid gap-3" data-testid="context-stack">
      {m.people.length ? (
        <div>
          <h3 className="text-13 font-bold">People</h3>
          <ul className="m-0 list-none p-0">{m.people.map((p) => row(p.id, p.title, null))}</ul>
        </div>
      ) : null}
      {m.focal ? (
        <div className="border-l-[3px] py-1 pl-3" style={{ borderColor: "var(--wf-blue)" }}>
          <h3 className="text-13 font-bold">Software system</h3>
          <p className="m-0 text-14 font-semibold">{m.focal.title}</p>
          <p className="m-0 text-12-5 text-muted">
            {m.focal.parts.length} {m.focal.parts.length === 1 ? "container" : "containers"}
          </p>
        </div>
      ) : null}
      {m.externals.length ? (
        <div>
          <h3 className="text-13 font-bold">External systems</h3>
          <ul className="m-0 list-none p-0">{m.externals.map((x) => row(x.id, x.title, x.owner))}</ul>
        </div>
      ) : null}
    </div>
  );
}

function Facts({ o, slug }: { o: SystemOverview; slug: string }) {
  return (
    <dl className="m-0 flex flex-wrap gap-x-9 gap-y-2" data-testid="overview-facts">
      {o.facts.map((f) => (
        <div key={f.label} className="grid gap-0.5">
          <dt className="text-12 font-semibold text-muted">{f.label}</dt>
          <dd className="m-0 text-14 font-semibold">
            <Tooltip label={f.tip} side="bottom" multiline>
              <span className="cursor-help">{f.value}</span>
            </Tooltip>
          </dd>
        </div>
      ))}
      {o.journey ? (
        <div className="grid min-w-0 gap-0.5">
          <dt className="text-12 font-semibold text-muted">Main journey</dt>
          <dd className="m-0 min-w-0 text-14 font-semibold">
            <Link href={workflowHref(slug, o.journey.document.flow)} className="text-link hover:underline">
              {o.journey.document.title}
            </Link>
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

/** The design's summary, three lines at most until asked for the rest. */
function Summary({ text, lines }: { text: string; lines: 2 | 3 }) {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;
  return (
    <div className="max-w-[86ch]">
      <p className={cn("m-0 text-14 leading-relaxed-1-6", !open && (lines === 2 ? "line-clamp-2" : "line-clamp-3"))}>{text}</p>
      {text.length > 220 ? (
        <button type="button" onClick={() => setOpen(!open)} className="mt-0.5 text-12-5 font-semibold text-link hover:underline">
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

export interface SystemOverviewRegionProps {
  records: readonly WorkflowRecord[];
  templates: readonly WorkflowTemplate[];
  slug: string;
  projectName: string;
  /** `page` heads Workflows; `compact` sits on the project dashboard and points to Workflows. */
  variant?: "page" | "compact";
}

/**
 * What the system is, read from its system-context design: the summary, the facts it states and the
 * C4 level 1 diagram, fitted whole into the region.
 */
export function SystemOverviewRegion({ records, templates, slug, projectName, variant = "page" }: SystemOverviewRegionProps) {
  const o = useMemo(() => systemOverview(records, templates), [records, templates]);
  const diagram = useMemo(() => (o ? layoutContext(o.model) : null), [o]);
  const compact = variant === "compact";
  const workflows = `/projects/${encodeURIComponent(slug)}/workflows`;

  if (!o) {
    return (
      <section className="border-b border-line-subtle bg-surface px-7 py-4 max-md:px-4" aria-label="System overview" data-testid="system-overview" data-empty>
        <p className="m-0 flex flex-wrap items-center gap-x-2 text-13-5">
          <b className="font-semibold">No system context yet.</b>
          <span className="text-muted">
            Ask the project&apos;s master to draw one in the system-context template: it is the design the others name.
          </span>
        </p>
      </section>
    );
  }
  const design = o.record;
  const status = design.design.status;
  return (
    <section
      className={cn("grid gap-3.5 border-b border-line-subtle bg-surface px-7 pb-5 pt-4 max-md:px-4", compact && "px-5")}
      aria-labelledby="system-overview-title"
      data-testid="system-overview"
    >
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        {compact ? (
          // The dashboard's own header already names the project.
          <h2 id="system-overview-title" className="fg-h3 m-0 min-w-0 flex-1">
            System overview
          </h2>
        ) : (
          <div className="grid min-w-0 flex-1 gap-0.5">
            <span className="text-12 font-semibold text-muted">System overview</span>
            <h2 id="system-overview-title" className="fg-h2 m-0">
              {projectName}
            </h2>
          </div>
        )}
        <span className="flex flex-wrap items-center gap-2.5 pt-1 max-md:order-last max-md:w-full max-md:pt-0">
          {status ? <DesignPill status={status} reason={design.design.returnReason ?? null} /> : null}
          <Link
            href={compact ? workflows : workflowHref(slug, design.document.flow)}
            className="inline-flex items-center gap-1 text-13 font-semibold text-link hover:underline"
            data-testid="open-system-context"
          >
            {compact ? "Open workflows" : "Open system context"}
            <Icon name="arrowRight" size={14} />
          </Link>
        </span>
      </div>
      <Summary text={design.document.summary} lines={compact ? 2 : 3} />
      <Facts o={o} slug={slug} />
      {diagram ? (
        <>
          <figure className="m-0 max-md:hidden" data-testid="overview-diagram">
            <C4Diagram
              diagram={diagram}
              title={`System context of ${o.model.focal?.title ?? projectName}`}
              className={cn("mx-auto block h-auto w-full", compact ? "max-h-[440px]" : "max-h-[660px]")}
              halo="var(--bg-surface)"
            />
          </figure>
          {compact ? null : (
            <div className="md:hidden">
              <ContextStack m={o.model} />
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
