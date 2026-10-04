"use client";

import type { WorkflowTemplate } from "@forge/contracts/workflow-templates";
import { Pencil } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useMemo, useState } from "react";
import { Button, HoverCard, Icon, Input, rememberListOrigin } from "@/design";
import { useOpenOnboarding } from "@/features/onboarding/components/onboarding-hint";
import { useOnboardingState } from "@/features/onboarding/hooks";
import { useWriteProjectDocument } from "@/features/project-settings/config-hooks";
import type { V1Read } from "@/features/project-settings/config-types";
import { formatApiError } from "@/lib/api/error";
import { refusalsOf } from "@/lib/api/refusals";
import { cn } from "@/lib/utils/cn";
import { templateFor } from "../canvas/model";
import { WorkflowCanvas } from "../canvas/workflow-canvas";
import { describeSystem, type OverviewFact, overviewFacts, type SystemDescription, type SystemOverview, sensitivityOf, systemOverview } from "../catalogue";
import { useSystemGraph } from "../hooks";
import { WORKFLOWS_LIST, workflowHref } from "../routes";
import type { SystemGraph, WorkflowRecord } from "../types";
import { DesignPill, SensitivityBadge } from "./workflow-parts";

const SOURCE: Record<SystemDescription["source"], string> = {
  project: "The project's description",
  purpose: "The system's purpose, from its system-context design",
  summary: "The first sentence of the system-context design's summary",
};

/** The project document with only `project.description` changed. */
export function describedDocument(document: Record<string, unknown>, description: string) {
  const project = (document.project ?? {}) as Record<string, unknown>;
  return { ...document, project: { ...project, description } };
}

/** One line, written into the project document at the revision read. */
function DescriptionEditor({ projectId, held, initial, onDone }: { projectId: string; held: Extract<V1Read, { declared: true }>; initial: string; onDone: () => void }) {
  const write = useWriteProjectDocument(projectId);
  const [text, setText] = useState(initial);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    write.mutate({ baseRevision: held.revision, document: describedDocument(held.document, value) }, { onSuccess: onDone });
  };
  const refusal = write.error ? (refusalsOf(write.error)[0]?.detail ?? formatApiError(write.error)) : null;
  return (
    <form className="grid max-w-[86ch] gap-1.5" onSubmit={submit} data-testid="description-editor">
      <span className="flex items-center gap-2">
        <Input
          aria-label="What the system is, in one line"
          placeholder="What the system is and who it is for, in one line"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="min-w-0 flex-1"
          autoFocus
        />
        <Button type="submit" size="sm" variant="primary" disabled={!text.trim()} loading={write.isPending}>
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </span>
      {refusal ? (
        <p role="alert" className="m-0 text-12 text-red">
          {refusal}
        </p>
      ) : null}
    </form>
  );
}

/**
 * What the system is, in one line, the rest behind hover or focus. A design's summary records how the
 * design was drawn, so it is never the headline for someone who can write the line instead.
 */
function Description({ o, graph, projectId, projectDocument, canEdit }: { o: SystemOverview; graph: SystemGraph | null; projectId: string; projectDocument: V1Read | undefined; canEdit: boolean }) {
  const [editing, setEditing] = useState(false);
  const described = describeSystem(projectDocument?.document, o, graph);
  const held = projectDocument?.declared ? projectDocument : null;
  const writable = canEdit && held !== null;
  if (editing && held) return <DescriptionEditor projectId={projectId} held={held} initial={described?.source === "project" ? described.text : ""} onDone={() => setEditing(false)} />;
  if (!described || (described.source === "summary" && writable)) {
    if (!writable) return null;
    return (
      <Button type="button" variant="ghost" size="sm" className="-ml-2 h-7 w-fit gap-1.5 px-2 text-13 font-normal text-muted" onClick={() => setEditing(true)} data-testid="add-description">
        <Pencil size={13} aria-hidden />
        Add a one-line description
      </Button>
    );
  }
  const summary = o.record.document.summary.trim();
  return (
    <span className="flex min-w-0 max-w-[96ch] items-center gap-2">
      <HoverCard
        label="About this system"
        className="block min-w-0 truncate text-14"
        data-testid="system-description"
        data-source={described.source}
        content={
          <div className="grid gap-2.5">
            <p className="m-0 text-14 leading-relaxed-1-6">{described.text}</p>
            {summary && summary !== described.text ? (
              <div className="grid gap-0.5 border-t border-line-subtle pt-2">
                <span className="text-12 font-semibold text-muted">How the system-context design was drawn</span>
                <p className="m-0 text-13 leading-relaxed-1-6 text-muted">{summary}</p>
              </div>
            ) : null}
            <span className="text-12 text-subtle">{SOURCE[described.source]}</span>
          </div>
        }
      >
        {described.text}
      </HoverCard>
      {writable ? (
        <Button type="button" variant="ghost" size="sm" className="h-6 w-6 flex-none p-0 text-subtle" aria-label="Edit the description" title="Edit the description" onClick={() => setEditing(true)}>
          <Pencil size={13} aria-hidden />
        </Button>
      ) : null}
    </span>
  );
}

function FactDetail({ f }: { f: OverviewFact }) {
  return (
    <ul className="m-0 grid min-w-[240px] list-none p-0" data-testid="fact-detail">
      {f.rows.map((r) => (
        <li key={r.name} className="flex items-baseline gap-3 border-t border-line-subtle py-1.5 first:border-t-0 first:pt-0 last:pb-0">
          <span className="min-w-0 flex-1 text-13">{r.name}</span>
          {r.count !== undefined ? (
            <span className="flex-none text-12-5 tabular-nums text-muted">
              {r.count}
              {r.unconfirmed ? <span className="text-subtle"> · {r.unconfirmed} unconfirmed</span> : null}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** The facts as label and value pairs on one line; what each counts opens on hover or focus. */
function Facts({ o, graph, slug, projectDocument }: { o: SystemOverview; graph: SystemGraph | null; slug: string; projectDocument: V1Read | undefined }) {
  const sensitivity = sensitivityOf(projectDocument?.document);
  return (
    <dl className="m-0 flex flex-wrap items-center gap-x-7 gap-y-1.5" data-testid="overview-facts">
      {(graph ? overviewFacts(graph) : []).map((f) => (
        <div key={f.label} className="flex items-baseline gap-2">
          <dt className="text-12-5 text-muted">{f.label}</dt>
          <dd className="m-0 text-13-5 font-semibold">
            <HoverCard label={f.label} content={<FactDetail f={f} />} className="underline decoration-line decoration-dotted underline-offset-4" data-testid="overview-fact">
              {f.value}
            </HoverCard>
          </dd>
        </div>
      ))}
      {sensitivity ? (
        <div className="flex items-center gap-2">
          <dt className="text-12-5 text-muted">Data</dt>
          <dd className="m-0">
            <SensitivityBadge level={sensitivity} />
          </dd>
        </div>
      ) : null}
      {o.journey ? (
        <div className="flex min-w-0 items-baseline gap-2">
          <dt className="text-12-5 text-muted">Main journey</dt>
          <dd className="m-0 min-w-0 truncate text-13-5 font-semibold">
            <Link href={workflowHref(slug, o.journey.document.flow)} onClick={() => rememberListOrigin(WORKFLOWS_LIST)} className="text-link hover:underline">
              {o.journey.document.title}
            </Link>
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

/**
 * One quiet line when the project has no system-context design yet. On Workflows it offers onboarding
 * (ISS-63), which drafts that design first; the dashboard carries onboarding's own line, so it does not.
 */
function NoContext({ projectId, quiet }: { projectId: string; quiet: boolean }) {
  const state = useOnboardingState(quiet ? undefined : projectId);
  const { open, pending, error } = useOpenOnboarding(projectId);
  const action = state.data?.hint?.action ?? "start";
  const refusal = error ? (refusalsOf(error)[0]?.detail ?? formatApiError(error)) : null;
  return (
    <section className="border-b border-line-subtle bg-surface px-7 py-4 max-md:px-4" aria-label="System overview" data-testid="system-overview" data-empty>
      <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-13-5">
        <b className="font-semibold">No system context yet.</b>
        {quiet ? (
          <span className="text-muted">Workflows shows what the system is once its system-context design is drawn.</span>
        ) : (
          <>
            <span className="text-muted">Onboarding drafts it first, from the code and a few questions.</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-auto p-0 text-13-5 font-semibold text-link hover:bg-transparent hover:underline"
              loading={pending}
              onClick={() => void open(action).catch(() => undefined)}
              data-testid="start-onboarding"
            >
              {action === "start" ? "Start onboarding" : "Open onboarding"}
            </Button>
          </>
        )}
      </p>
      {refusal ? (
        <p role="alert" className="mt-1 text-12 text-red">
          {refusal}
        </p>
      ) : null}
    </section>
  );
}

export interface SystemOverviewRegionProps {
  records: readonly WorkflowRecord[];
  templates: readonly WorkflowTemplate[];
  projectId: string;
  slug: string;
  projectName: string;
  /** The project document as read: its description, and its data policy when it restricts anything. */
  projectDocument?: V1Read;
  /** The viewer may write the project document, so may add the description. */
  canEdit?: boolean;
  /** `page` is Workflows' left pane; `compact` sits on the project dashboard and points to Workflows. */
  variant?: "page" | "compact";
  className?: string;
}

/**
 * What the system is: one line about it, the facts its system-context design states, and that design on
 * the shared canvas in its compact mode, folded by boundary until it reads at 12px.
 */
export function SystemOverviewRegion({ records, templates, projectId, slug, projectName, projectDocument, canEdit = false, variant = "page", className }: SystemOverviewRegionProps) {
  const o = useMemo(() => systemOverview(records), [records]);
  const graphRef = useMemo(() => (o ? { projectId, workflowId: o.record.document.id, revision: o.record.revision } : null), [o, projectId]);
  const graph = useSystemGraph(graphRef);
  const compact = variant === "compact";
  const workflows = `/projects/${encodeURIComponent(slug)}/workflows`;

  if (!o) return <NoContext projectId={projectId} quiet={compact} />;
  const design = o.record;
  const status = design.design.status;
  const template = templateFor(design.document, templates);
  return (
    <section
      className={cn("flex min-h-0 min-w-0 flex-col bg-app", compact && "border-b border-line-subtle", className)}
      aria-labelledby="system-overview-title"
      data-testid="system-overview"
    >
      <div className={cn("grid gap-2 border-b border-line-subtle bg-surface px-6 pb-3 pt-3.5 max-md:px-4", compact && "px-5")}>
        <div className="flex flex-wrap items-start gap-x-4 gap-y-1.5">
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
          <span className="flex flex-wrap items-center gap-2.5 pt-1">
            {status ? <DesignPill status={status} reason={design.design.returnReason ?? null} /> : null}
            <Link
              href={compact ? workflows : workflowHref(slug, design.document.flow)}
              onClick={compact ? undefined : () => rememberListOrigin(WORKFLOWS_LIST)}
              className="inline-flex items-center gap-1 text-13 font-semibold text-link hover:underline"
              data-testid="open-system-context"
            >
              {compact ? "Open workflows" : "Open system context"}
              <Icon name="arrowRight" size={14} />
            </Link>
          </span>
        </div>
        {graph.isPending ? null : <Description o={o} graph={graph.data ?? null} projectId={projectId} projectDocument={projectDocument} canEdit={canEdit} />}
        <Facts o={o} graph={graph.data ?? null} slug={slug} projectDocument={projectDocument} />
      </div>
      <div className={cn("flex min-h-0 flex-1", compact ? "h-[620px] flex-none max-md:h-[64vh]" : "min-h-[420px] max-lg:h-[64vh] max-lg:flex-none")} data-testid="overview-diagram">
        <WorkflowCanvas doc={design.document} template={template} graph={graphRef} compact />
      </div>
    </section>
  );
}
