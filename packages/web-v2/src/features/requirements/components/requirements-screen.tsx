"use client";

import Link from "next/link";
import { useState } from "react";
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  PageTitle,
  ProjectLoader,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Textarea,
  TopBarActions,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { cn } from "@/lib/utils/cn";
import { formatRelativeTime } from "@/lib/utils/format";
import { useQueryParam } from "@/lib/utils/use-query-param";
import { useCreateRequirement, useRequirements } from "../hooks";
import { requirementHref } from "../routes";
import type { RequirementSummary } from "../types";
import { PhaseBadge, RequirementStatusBadge, RevisionStateBadge } from "./badges";
import { RequirementDetailView } from "./requirement-detail";
import { RefusalLine } from "./refusal";

function CreateForm({ projectId, onDone }: { projectId: string; onDone: (key: string) => void }) {
  const create = useCreateRequirement(projectId);
  const [title, setTitle] = useState("");
  const [reason, setReason] = useState("");
  const [criteria, setCriteria] = useState("");
  const lines = criteria
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return (
    <form
      className="grid max-w-2xl gap-3 bg-surface px-4 py-4 sm:px-7"
      data-testid="requirement-create"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate(
          { title: title.trim(), reason: reason.trim(), criteria: lines.map((body) => ({ body })) },
          { onSuccess: (d) => onDone(d.key) },
        );
      }}
    >
      <Field label="Title" required>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </Field>
      <Field label="Reason" hint="Why this requirement is being written">
        <Input value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <Field label="Criteria" hint="One criterion per line">
        <Textarea value={criteria} onChange={(e) => setCriteria(e.target.value)} rows={4} />
      </Field>
      <RefusalLine error={create.error} />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" loading={create.isPending} disabled={!title.trim()}>
          Create requirement
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => onDone("")}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Row({ r, selected, onOpen }: { r: RequirementSummary; selected: boolean; onOpen: () => void }) {
  const phase = (r.status === "agreed" || r.status === "accepted") && r.delivery.phase ? r.delivery.phase : null;
  return (
    <TR
      className={cn("cursor-pointer", selected && "bg-active hover:bg-active")}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      tabIndex={0}
      aria-selected={selected}
      data-testid="requirement-row"
      data-key={r.key}
    >
      <TD className="whitespace-nowrap font-mono text-12 text-muted">{r.key}</TD>
      <TD className="font-medium">{r.title}</TD>
      <TD>
        <RequirementStatusBadge status={r.status} />
      </TD>
      <TD className="whitespace-nowrap">
        {r.latestRevision ? (
          <span className="inline-flex items-center gap-2">
            <span className="font-mono text-12 text-muted" title={r.currentRevision ? `Current: r${r.currentRevision}` : "No current revision"}>
              r{r.latestRevision.revision}
            </span>
            <RevisionStateBadge state={r.latestRevision.state} />
          </span>
        ) : (
          <span className="text-subtle">None</span>
        )}
      </TD>
      <TD>{phase ? <PhaseBadge phase={phase} /> : null}</TD>
      <TD className="whitespace-nowrap text-12 text-muted" title={new Date(r.updatedAt).toLocaleString()}>
        {formatRelativeTime(r.updatedAt)}
      </TD>
    </TR>
  );
}

export function RequirementsScreen({ projectId, slug }: { projectId: string; slug: string }) {
  const q = useRequirements(projectId);
  const [peek, setPeek] = useQueryParam("peek");
  const [creating, setCreating] = useState(false);

  const title = (
    <>
      <PageTitle>Requirements</PageTitle>
      <TopBarActions>
        <Button type="button" variant="primary" size="sm" icon="plus" onClick={() => setCreating(true)} disabled={creating}>
          Requirement
        </Button>
      </TopBarActions>
    </>
  );

  if (q.isLoading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        {title}
        <ProjectLoader label="loading requirements…" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        {title}
        <ErrorState message={formatApiError(q.error)} onRetry={() => q.refetch()} />
      </div>
    );
  }
  const rows = q.data.requirements;
  const open = peek && rows.some((r) => r.key === peek) ? peek : null;

  return (
    <div className="grid content-start" data-testid="requirements-screen">
      {title}
      {creating ? (
        <CreateForm
          projectId={projectId}
          onDone={(key) => {
            setCreating(false);
            if (key) setPeek(key);
          }}
        />
      ) : null}
      <div className={cn("grid min-h-[60vh]", open && "lg:grid-cols-[minmax(0,1fr)_minmax(360px,440px)]")}>
        <div className="min-w-0">
          {rows.length === 0 ? (
            <div className="px-4 py-10 sm:px-7">
              <EmptyState title="No requirement has been written" message="A requirement says what is wanted and how anyone can tell it is done." />
            </div>
          ) : (
            <Table flush aria-label="Requirements">
              <THead className="bg-sunken">
                <tr>
                  <TH className="w-24">Key</TH>
                  <TH>Title</TH>
                  <TH>Status</TH>
                  <TH>Revision</TH>
                  <TH>Delivery</TH>
                  <TH>Updated</TH>
                </tr>
              </THead>
              <TBody>
                {rows.map((r) => (
                  <Row key={r.id} r={r} selected={r.key === open} onOpen={() => setPeek(r.key === open ? null : r.key)} />
                ))}
              </TBody>
            </Table>
          )}
        </div>
        {open ? (
          <aside
            className="fixed inset-0 z-30 overflow-y-auto bg-surface px-5 py-5 lg:static lg:inset-auto lg:z-auto lg:border-l lg:border-line"
            aria-label={`${open} summary`}
            data-testid="requirement-peek"
          >
            <RequirementDetailView
              key={open}
              projectId={projectId}
              slug={slug}
              reqKey={open}
              full={false}
              head={
                <>
                  <Link href={requirementHref(slug, open)} className="text-12 font-semibold text-accent hover:underline">
                    Open full page
                  </Link>
                  <IconButton icon="x" size="sm" aria-label="Close" onClick={() => setPeek(null)} />
                </>
              }
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
