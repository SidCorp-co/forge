"use client";

// A requirement's full page (`forge-prototype.html` #/requirements/REQ-12): a main column of four
// zones — 1 Where it stands, 2 What it is, 3 Proof, 5 History — and the relations rail (4), each a
// region by background tone rather than a box. Everything derived (whose turn, coverage, history)
// comes from core's read model; this file only lays it out.

import type { ReactNode } from "react";
import { ErrorState, ProjectLoader } from "@/design";
import { formatApiError, isRetryableApiError } from "@/lib/api/error";
import { cn } from "@/lib/utils/cn";
import { formatRelativeTime } from "@/lib/utils/format";
import { useRequirement, useRequirementSuggestions } from "../hooks";
import type { RequirementCriterion, RequirementDetail, RequirementRevision } from "../types";
import { PrimaryActions, ProposalDecision } from "./requirement-actions";
import { Source, decidingFacts } from "./requirement-peek";
import { History, ProofChain, Readiness, RelationsRail, RevisionDiff, SubHead } from "./requirement-proof";
import { CoverageMarks, RevisionTimeline, StateBadge, Stepper, WaitBanner, stamp } from "./standing-bits";
import { PendingBadge, RequirementSuggestions } from "./suggestions";
import { AI_TINT } from "./tone";

function ZoneHead({ n, title, q, rail }: { n: number; title: string; q: string; rail?: boolean }) {
  return (
    <h2
      id={`zone-${n}`}
      className={cn(
        "mb-3 flex items-baseline gap-2 bg-sunken py-[7px] text-13 font-bold",
        rail ? "-mx-4 px-4 max-md:-mx-3 max-md:px-3" : "-ml-5 -mr-6 px-5 max-md:-mx-3 max-md:px-3",
      )}
    >
      <span className="font-mono text-11 font-semibold text-subtle">{n}</span>
      {title}
      <span className="text-12 font-medium text-subtle">{q}</span>
    </h2>
  );
}

function Zone({ n, title, q, children, className }: { n: number; title: string; q: string; children: ReactNode; className?: string }) {
  return (
    <section aria-labelledby={`zone-${n}`} className={cn("min-w-0 pb-5 pl-5 pr-6 max-md:px-3", className)} data-testid={`zone-${n}`}>
      <ZoneHead n={n} title={title} q={q} />
      {children}
    </section>
  );
}

function Label({ children, note }: { children: ReactNode; note?: string }) {
  return (
    <div className="mb-1.5 mt-3.5 flex flex-wrap items-baseline gap-2 text-12 font-semibold text-subtle">
      {children}
      {note ? <span className="font-medium">{note}</span> : null}
    </div>
  );
}

function WhereItStands({ d, projectId, slug }: { d: RequirementDetail; projectId: string; slug: string }) {
  const s = d.standing;
  const facts = decidingFacts(d, slug).filter((f) => f.label !== "Revision");
  return (
    <Zone n={1} title="Where it stands" q="State, who acts next, the facts that decide it">
      <div className="mb-1 mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-2">
        <span className="font-mono text-11-5 font-semibold text-link" title={d.id}>
          {d.key}
        </span>
        <StateBadge state={s.state} />
        <div className="ml-auto">
          <PrimaryActions
            projectId={projectId}
            slug={slug}
            d={d}
            onReview={() => document.getElementById("proposal")?.scrollIntoView({ behavior: "smooth", block: "start" })}
          />
        </div>
      </div>
      <WaitBanner standing={s} />
      <Stepper state={s.state} />
      <div className="grid gap-x-7 lg:grid-cols-[auto_minmax(0,1fr)]">
        <div>
          <Label note="By business criterion">Coverage</Label>
          <CoverageMarks coverage={s.coverage} large labelled />
        </div>
        <div className="min-w-0">
          <Label>Revisions</Label>
          <RevisionTimeline revisions={d.revisions} baselines={d.baselines} />
        </div>
      </div>
      <div className="mt-1.5 grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-x-7">
        {facts.map((f) => (
          <div key={f.label} className="grid gap-0.5 border-b border-line-subtle py-2 text-13">
            <span className="text-12 text-subtle">{f.label}</span>
            <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">{f.value}</span>
            {f.source ? <span className="min-w-0">{f.source}</span> : null}
          </div>
        ))}
      </div>
    </Zone>
  );
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="my-1 grid list-disc gap-0.5 pl-[18px] text-13-5">
      {items.map((x) => (
        <li key={x}>{x}</li>
      ))}
    </ul>
  );
}

const H5 = ({ children }: { children: ReactNode }) => (
  <h5 className="mb-1 mt-4 flex flex-wrap items-center gap-2 text-12-5 font-bold text-muted">{children}</h5>
);

function Criteria({ criteria, shown }: { criteria: RequirementCriterion[]; shown: number }) {
  if (criteria.length === 0) return <p className="py-1.5 text-12-5 text-subtle">No criteria yet. Readiness needs at least one testable criterion.</p>;
  return (
    <div data-testid="requirement-criteria">
      {criteria.map((c) => (
        <div key={c.id} className="grid grid-cols-[44px_minmax(0,1fr)] gap-2.5 border-b border-line-subtle py-2 text-13 last:border-0">
          <span className="font-mono text-11-5 font-semibold text-muted" title={`Since r${c.sinceRevision}`}>
            {c.code}
          </span>
          <span>
            {c.form === "scenario" ? <pre className="whitespace-pre-wrap font-mono text-12 leading-relaxed">{c.body}</pre> : c.body}
            {c.sinceRevision === shown && shown > 1 ? <span className="ml-1 text-12 text-subtle">(changed in r{shown})</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

function OpenRevision({ d, projectId, open }: { d: RequirementDetail; projectId: string; open: RequirementRevision }) {
  const base = d.revisions.find((r) => r.revision === (open.baseRevision ?? d.currentRevision ?? -1)) ?? d.revisions.find((r) => r.state === "current");
  const proposed = open.state === "proposed";
  return (
    <div
      id="proposal"
      className="my-2.5 scroll-mt-4 border-l-[3px] px-3 py-[9px] text-12-5"
      style={{ background: AI_TINT.bg, borderColor: AI_TINT.bar }}
      data-testid="open-revision"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold" style={{ color: AI_TINT.fg }}>
          {proposed ? "Proposal" : "Draft"} r{open.revision}
        </span>
        {proposed ? <PendingBadge /> : <span className="text-12 text-subtle">In draft</span>}
        <Source
          kind="person"
          who={open.authorName ?? "Its author"}
          rel={formatRelativeTime(open.proposedAt ?? open.createdAt)}
          tip={`${proposed ? "Proposed" : "Written"} ${stamp(open.proposedAt ?? open.createdAt)}`}
        />
      </div>
      <p className="my-1.5 text-13-5">{open.changeSummary ?? open.reason}</p>
      <details className="text-12-5">
        <summary className="cursor-pointer select-none font-semibold" style={{ color: AI_TINT.fg }}>
          Show full {proposed ? "proposal" : "draft"}
        </summary>
        <div className="mt-1.5 border-t border-line-subtle pt-1">
          {open.changeSummary && open.reason !== open.changeSummary ? <p className="mt-1 text-12-5 text-muted">Why: {open.reason}</p> : null}
          <RevisionDiff base={base} next={open} />
        </div>
      </details>
      {proposed ? (
        <div className="pt-2">
          <ProposalDecision projectId={projectId} d={d} revision={open.revision} />
        </div>
      ) : null}
    </div>
  );
}

function WhatItIs({ d, projectId }: { d: RequirementDetail; projectId: string }) {
  const shown = d.revisions.find((r) => r.state === "current") ?? d.revisions[0];
  const open = d.revisions.find((r) => r.state === "proposed" || r.state === "draft");
  const spec = shown?.spec ?? {};
  const criteria = d.criteria.length > 0 ? d.criteria : (shown?.criteria ?? []);
  return (
    <Zone n={2} title="What it is" q="Goal, scope, business criteria">
      {shown?.tldr ? (
        <div className="mb-2.5 border-l-[3px] border-[var(--paper-400)] bg-app px-3 py-2">
          <span className="text-12 font-semibold text-subtle">TL;DR · r{shown.revision}</span>
          <p className="mt-1 text-13-5">{shown.tldr}</p>
        </div>
      ) : null}
      {open && open !== shown ? <OpenRevision d={d} projectId={projectId} open={open} /> : null}
      <div>
        {spec.goal ? (
          <>
            <H5>
              Goal and problem
              {shown ? <Source kind="person" who={shown.authorName ?? "Its author"} rel={`r${shown.revision}`} /> : null}
            </H5>
            <p className="text-13-5 leading-relaxed">{spec.goal}</p>
          </>
        ) : null}
        {spec.personas?.length ? (
          <>
            <H5>Persona</H5>
            <Bullets items={spec.personas} />
          </>
        ) : null}
        {spec.scopeIn?.length ? (
          <>
            <H5>In scope</H5>
            <Bullets items={spec.scopeIn} />
          </>
        ) : null}
        {spec.scopeOut?.length ? (
          <>
            <H5>Out of scope</H5>
            <Bullets items={spec.scopeOut} />
          </>
        ) : null}
        <H5>Business criteria</H5>
        <Criteria criteria={criteria} shown={shown?.revision ?? 0} />
      </div>
      {d.canSignOff ? (
        <div className="mt-3">
          <RequirementSuggestions projectId={projectId} reqKey={d.key} />
        </div>
      ) : null}
    </Zone>
  );
}

function Proof({ d, projectId, slug }: { d: RequirementDetail; projectId: string; slug: string }) {
  const sug = useRequirementSuggestions(projectId, d.key);
  const judged = d.standing.facts;
  return (
    <Zone n={3} title="Proof" q="Traceability and readiness">
      <SubHead right={`Passing ${judged.passing} of ${judged.criteria}`}>Business criterion → issues → verdict</SubHead>
      <ProofChain d={d} slug={slug} />
      <SubHead>Readiness</SubHead>
      <Readiness suggestions={sug.data?.suggestions ?? []} />
    </Zone>
  );
}

export function RequirementPage({ projectId, slug, reqKey }: { projectId: string; slug: string; reqKey: string }) {
  const q = useRequirement(projectId, reqKey);
  if (q.isLoading) {
    return (
      <div className="grid min-h-[40vh] place-items-center">
        <ProjectLoader label="loading requirement…" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="grid min-h-[40vh] place-items-center">
        <ErrorState message={formatApiError(q.error)} onRetry={isRetryableApiError(q.error) ? () => q.refetch() : undefined} />
      </div>
    );
  }
  const d = q.data;
  return (
    <article
      className="grid min-h-full items-start bg-surface lg:grid-cols-[minmax(0,1fr)_300px] lg:grid-rows-[auto_auto_auto_1fr]"
      data-testid="requirement-detail"
      data-key={d.key}
    >
      <WhereItStands d={d} projectId={projectId} slug={slug} />
      <WhatItIs d={d} projectId={projectId} />
      <Proof d={d} projectId={projectId} slug={slug} />
      <aside
        aria-labelledby="zone-4"
        className="min-w-0 self-stretch border-line-subtle bg-app px-4 pb-6 max-lg:border-t max-md:px-3 lg:col-start-2 lg:row-span-4 lg:row-start-1 lg:border-l"
        data-testid="relations-rail"
      >
        <h2 id="zone-4" className="-mx-4 mb-2.5 flex items-baseline gap-2 bg-sunken px-4 py-[7px] text-13 font-bold max-md:-mx-3 max-md:px-3">
          <span className="font-mono text-11 font-semibold text-subtle">4</span>
          Relations
          <span className="text-12 font-medium text-subtle">And properties</span>
        </h2>
        <RelationsRail d={d} slug={slug} />
      </aside>
      <Zone n={5} title="History" q="Who did what, filtered by source" className="lg:col-start-1">
        <History entries={d.history} />
      </Zone>
    </article>
  );
}
