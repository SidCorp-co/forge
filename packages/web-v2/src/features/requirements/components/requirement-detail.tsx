"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Button, ErrorState, Input, ProjectLoader } from "@/design";
import { formatApiError, isRetryableApiError } from "@/lib/api/error";
import { formatRelativeTime } from "@/lib/utils/format";
import { workflowHref } from "@/features/workflows/routes";
import { useRequirement, useRequirementAction } from "../hooks";
import type {
  RequirementBaseline,
  RequirementCriterion,
  RequirementDetail,
  RequirementPin,
  RequirementRevision,
} from "../types";
import {
  DesignStatusBadge,
  IssueStatusBadge,
  PhaseBadge,
  RequirementStatusBadge,
  RevisionStateBadge,
} from "./badges";
import { RefusalLine } from "./refusal";
import { RequirementSuggestions } from "./suggestions";

const stamp = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : null);

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="grid gap-2">
      <h3 className="text-12 font-semibold text-muted">
        {title}
        {count !== undefined ? <span className="ml-1.5 font-normal text-subtle">{count}</span> : null}
      </h3>
      {children}
    </section>
  );
}

const Quiet = ({ children }: { children: ReactNode }) => <p className="text-13 text-subtle">{children}</p>;

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="grid list-disc gap-1 pl-5 text-14">
      {items.map((s) => (
        <li key={s}>{s}</li>
      ))}
    </ul>
  );
}

function Criteria({ criteria }: { criteria: RequirementCriterion[] }) {
  if (criteria.length === 0) return <Quiet>No criteria.</Quiet>;
  return (
    <ul className="grid gap-2.5" data-testid="requirement-criteria">
      {criteria.map((c) => (
        <li key={c.id} className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-x-3 text-14">
          <span className="pt-px font-mono text-12 text-muted" title={`Since r${c.sinceRevision}`}>
            {c.code}
          </span>
          <div className="grid gap-1">
            {c.form === "scenario" ? (
              <>
                <span className="text-11 font-semibold text-subtle" title="form: scenario">
                  Scenario
                </span>
                <pre className="whitespace-pre-wrap font-mono text-12 leading-relaxed">{c.body}</pre>
              </>
            ) : (
              <span>{c.body}</span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function revisionTip(r: RequirementRevision): string {
  return [
    `Written ${stamp(r.createdAt)}`,
    r.proposedAt ? `Proposed ${stamp(r.proposedAt)}` : null,
    r.decidedAt ? `Decided ${stamp(r.decidedAt)} by ${r.decidedByName ?? r.decidedBy}` : null,
    r.returnReason ? `Returned: ${r.returnReason}` : null,
    r.baseRevision !== null ? `Based on r${r.baseRevision}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function RevisionHistory({ revisions }: { revisions: RequirementRevision[] }) {
  return (
    <ul className="grid" data-testid="requirement-revisions">
      {revisions.map((r) => (
        <li
          key={r.revision}
          className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line-subtle py-2 text-13 last:border-0"
          title={revisionTip(r)}
        >
          <span className="w-8 font-mono text-12 text-muted">r{r.revision}</span>
          <RevisionStateBadge state={r.state} />
          <span className="text-muted">{r.authorName ?? "Unknown author"}</span>
          <span className="min-w-0 flex-1">{r.changeSummary ?? r.reason}</span>
          <span className="text-12 text-subtle">{formatRelativeTime(r.decidedAt ?? r.proposedAt ?? r.createdAt)}</span>
        </li>
      ))}
    </ul>
  );
}

function pinLabel(p: RequirementPin): string {
  if (p.kind === "workflow-design") return `Design ${p.flow ?? p.workflowId ?? "?"} r${p.designRevision ?? "?"}`;
  return `Contract ${p.contractSlug ?? "?"}@${p.contractVersion ?? "?"}`;
}

function Baselines({ baselines }: { baselines: RequirementBaseline[] }) {
  return (
    <ul className="grid" data-testid="requirement-baselines">
      {baselines.map((b) => (
        <li key={`${b.revision}-${b.agreedAt}`} className="grid gap-1 border-b border-line-subtle py-2 text-13 last:border-0">
          <div className="flex flex-wrap items-baseline gap-x-3" title={`Agreed ${stamp(b.agreedAt)}${b.reason ? `\n${b.reason}` : ""}`}>
            <span className="w-8 font-mono text-12 text-muted">r{b.revision}</span>
            <span>Agreed by {b.agreedByName ?? b.agreedBy}</span>
            <span className="text-12 text-subtle">{formatRelativeTime(b.agreedAt)}</span>
          </div>
          {b.pins.length > 0 ? (
            <details className="pl-11 text-12 text-muted">
              <summary className="cursor-pointer select-none">
                {b.pins.length} {b.pins.length === 1 ? "pin" : "pins"}
              </summary>
              <ul className="mt-1 grid gap-0.5 font-mono">
                {b.pins.map((p) => (
                  <li key={pinLabel(p)} title={p.kind}>
                    {pinLabel(p)}
                  </li>
                ))}
              </ul>
            </details>
          ) : (
            <span className="pl-11 text-12 text-subtle">No pins</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function Actions({ projectId, d }: { projectId: string; d: RequirementDetail }) {
  const act = useRequirementAction(projectId, d.key);
  const [returning, setReturning] = useState(false);
  const [reason, setReason] = useState("");
  const draft = d.revisions.find((r) => r.state === "draft");
  const proposed = d.revisions.find((r) => r.state === "proposed");
  const head = d.revisions[0];
  const canAgree = d.canSignOff && d.status === "draft" && head?.state === "current";
  const busy = act.isPending;
  if (!draft && !(proposed && d.canSignOff) && !canAgree) return null;

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {draft ? (
          <Button type="button" size="sm" variant="primary" loading={busy} onClick={() => act.mutate({ kind: "propose", revision: draft.revision })}>
            Propose r{draft.revision}
          </Button>
        ) : null}
        {proposed && d.canSignOff ? (
          <>
            <Button type="button" size="sm" variant="primary" loading={busy} onClick={() => act.mutate({ kind: "accept", revision: proposed.revision })}>
              Accept r{proposed.revision}
            </Button>
            <Button type="button" size="sm" disabled={busy} onClick={() => setReturning((v) => !v)} aria-expanded={returning}>
              Return
            </Button>
          </>
        ) : null}
        {canAgree && head ? (
          <Button type="button" size="sm" variant="primary" loading={busy} onClick={() => act.mutate({ kind: "agree", revision: head.revision })}>
            Agree r{head.revision}
          </Button>
        ) : null}
      </div>
      {returning && proposed ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            act.mutate(
              { kind: "return", revision: proposed.revision, reason: reason.trim() },
              { onSuccess: () => { setReturning(false); setReason(""); } },
            );
          }}
        >
          <Input
            aria-label="Why it goes back"
            placeholder="Why it goes back"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="min-w-[16rem] flex-1"
            autoFocus
          />
          <Button type="submit" size="sm" disabled={!reason.trim()} loading={busy}>
            Return r{proposed.revision}
          </Button>
        </form>
      ) : null}
      <RefusalLine error={act.error} />
    </div>
  );
}

export function RequirementDetailView({
  projectId,
  slug,
  reqKey,
  full,
  head,
}: {
  projectId: string;
  slug: string;
  reqKey: string;
  /** The full page shows the history, designs, baselines and issues; the peek shows the summary. */
  full: boolean;
  /** Drawn on the key line's far end: the peek's "Open full page" and close controls. */
  head?: ReactNode;
}) {
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
        <ErrorState
          message={formatApiError(q.error)}
          onRetry={isRetryableApiError(q.error) ? () => q.refetch() : undefined}
        />
      </div>
    );
  }
  const d = q.data;
  const shown = d.revisions.find((r) => r.state === "current") ?? d.revisions[0];
  const criteria = d.criteria.length > 0 ? d.criteria : (shown?.criteria ?? []);
  const spec = shown?.spec ?? {};
  const phase = (d.status === "agreed" || d.status === "accepted") && d.delivery.phase ? d.delivery.phase : null;

  return (
    <article className="grid content-start gap-6" data-testid="requirement-detail" data-key={d.key}>
      <header className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-12 text-muted" title={d.id}>
            {d.key}
          </span>
          <RequirementStatusBadge status={d.status} />
          {phase ? <PhaseBadge phase={phase} /> : null}
          {shown ? (
            <span className="text-12 text-subtle" title={`Revision ${shown.revision} is ${shown.state}`}>
              r{shown.revision}
            </span>
          ) : null}
          {head ? <span className="ml-auto flex items-center gap-2">{head}</span> : null}
        </div>
        <h2 className={full ? "fg-h2" : "fg-h3"}>{d.title}</h2>
      </header>

      <Actions projectId={projectId} d={d} />
      {d.canSignOff ? <RequirementSuggestions projectId={projectId} reqKey={d.key} /> : null}

      {shown?.tldr ? <p className="text-14 leading-relaxed">{shown.tldr}</p> : null}
      {spec.goal ? (
        <Section title="Goal">
          <p className="text-14 leading-relaxed">{spec.goal}</p>
        </Section>
      ) : null}
      {full && spec.personas?.length ? (
        <Section title="Personas">
          <Bullets items={spec.personas} />
        </Section>
      ) : null}
      {spec.scopeIn?.length ? (
        <Section title="In scope">
          <Bullets items={spec.scopeIn} />
        </Section>
      ) : null}
      {spec.scopeOut?.length ? (
        <Section title="Out of scope">
          <Bullets items={spec.scopeOut} />
        </Section>
      ) : null}

      <Section title="Criteria" count={criteria.length}>
        <Criteria criteria={criteria} />
      </Section>

      <Section title="Issues" count={d.issues.length}>
        {d.issues.length === 0 ? (
          <Quiet>No issue is linked.</Quiet>
        ) : (
          <ul className="grid" data-testid="requirement-issues">
            {d.issues.map((i) => (
              <li key={i.issueId} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line-subtle py-2 text-13 last:border-0">
                <Link href={`/projects/${encodeURIComponent(slug)}/issues/${encodeURIComponent(i.displayId)}`} className="font-mono text-12 text-muted hover:text-fg">
                  {i.displayId}
                </Link>
                <span className="min-w-0 flex-1">{i.title}</span>
                {i.changedSincePlan ? (
                  <span
                    className="text-12 font-semibold"
                    style={{ color: "var(--amberw-600)" }}
                    title={`Planned against r${i.plannedRevision ?? "?"}; the requirement has moved since`}
                    data-testid="changed-since-plan"
                  >
                    Changed since plan
                  </span>
                ) : null}
                <IssueStatusBadge status={i.status} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      {full ? (
        <>
          <Section title="Designs" count={d.workflows.length}>
            {d.workflows.length === 0 ? (
              <Quiet>No design is linked.</Quiet>
            ) : (
              <ul className="grid">
                {d.workflows.map((w) => (
                  <li key={w.workflowId} className="flex flex-wrap items-baseline gap-x-3 border-b border-line-subtle py-2 text-13 last:border-0">
                    <Link href={workflowHref(slug, w.flow)} className="font-mono text-12 text-muted hover:text-fg">
                      {w.flow}
                    </Link>
                    <span className="min-w-0 flex-1">{w.title}</span>
                    {w.designStatus ? <DesignStatusBadge status={w.designStatus} /> : null}
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Revisions" count={d.revisions.length}>
            <RevisionHistory revisions={d.revisions} />
          </Section>
          <Section title="Baselines" count={d.baselines.length}>
            {d.baselines.length === 0 ? <Quiet>Not agreed yet.</Quiet> : <Baselines baselines={d.baselines} />}
          </Section>
        </>
      ) : (
        <p className="text-12 text-subtle">
          {d.revisions.length} {d.revisions.length === 1 ? "revision" : "revisions"} · {d.workflows.length}{" "}
          {d.workflows.length === 1 ? "design" : "designs"} · {d.baselines.length}{" "}
          {d.baselines.length === 1 ? "baseline" : "baselines"}
        </p>
      )}
    </article>
  );
}
