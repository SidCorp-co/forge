"use client";

// The Requirements list (`forge-prototype.html` #/requirements): the grouping in the top header, a
// search, the BA assistant's open suggestions, then the shared GroupedList by whose turn it is. Each
// row reads core's standing (`requirements/standing.ts`); nothing here derives whose turn it is.
// The URL carries the view (`?group=…&q=…&peek=REQ-n`), so back from the full page restores it.

import {
  REQUIREMENT_ATTENTION_GROUPS,
  REQUIREMENT_ATTENTION_LABELS,
  REQUIREMENT_STATE_LABELS,
  REQUIREMENT_STATE_TONES,
  REQUIREMENT_STATES,
} from "@forge/contracts/requirements";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { ActorChip, AGENT_TINT, Button, EmptyState, ErrorState, Field, GroupedList, Input, ListSearch, type ListGroup, type ListRowView, PageTitle, ProjectLoader, rememberListOrigin, StatusBadge, Textarea, TopBarActions, useGroupFold, usePeek, usePeekKeys, useUrlParams, useViewMode, ViewModeSwitcher, visibleRows, WaitingOn } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { formatApiError } from "@/lib/api/error";
import { formatAge, formatStamp } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import { PendingBadge, summaryOf } from "@/features/suggestions/components/suggestion-list";
import { requirementAffected, useProjectWaitingSuggestions, useSuggestionDecision } from "@/features/suggestions/hooks";
import type { SuggestionView as Suggestion } from "@/features/suggestions/types";
import { useCreateRequirement, useRequirements } from "../hooks";
import { REQUIREMENTS_LIST, requirementHref } from "../../../lib/routes/requirements";
import type { RequirementSummary } from "../types";
import { RequirementPeek } from "./requirement-peek";
import { revisionText } from "./standing-bits";

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
      className="grid max-w-2xl gap-3 border-b border-line-subtle bg-surface px-5 py-4"
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

const GROUP_MODES = [
  { value: "attention" as const, label: "Attention", title: "Grouped by whose turn it is" },
  { value: "status" as const, label: "Status", title: "Grouped by lifecycle state" },
];
type GroupMode = (typeof GROUP_MODES)[number]["value"];

function groupsOf(rows: RequirementSummary[], mode: GroupMode): ListGroup<RequirementSummary>[] {
  if (mode === "status") {
    return REQUIREMENT_STATES.map((s) => ({
      id: `status:${s}`,
      label: REQUIREMENT_STATE_LABELS[s],
      tone: REQUIREMENT_STATE_TONES[s],
      collapsed: s === "accepted" || s === "dropped",
      rows: rows.filter((r) => r.standing.state === s),
    }));
  }
  return REQUIREMENT_ATTENTION_GROUPS.map((g) => ({
    id: g,
    ...REQUIREMENT_ATTENTION_LABELS[g],
    rows: rows.filter((r) => r.standing.attentionGroup === g),
  }));
}

/** The secondary line: revision, coverage, issues — label-first counts. */
function factsLine(r: RequirementSummary): string[] {
  const f = r.standing.facts;
  const parts = [revisionText(r.currentRevision, r.standing)];
  if (f.issuesTotal === 0 && f.judged === 0) parts.push(f.criteria ? `Criteria ${f.criteria}` : "No criteria");
  else parts.push(`Passing ${f.passing}/${f.criteria}`);
  parts.push(f.issuesTotal === 0 ? "Not broken down" : `Issues done ${f.issuesDone}/${f.issuesTotal}`);
  return parts;
}

const rowOf =
  (slug: string) =>
  (r: RequirementSummary): ListRowView => ({
    key: r.key,
    href: requirementHref(slug, r.key),
    title: r.title,
    facts: factsLine(r),
    state: <StatusBadge family="requirement" value={r.standing.state} />,
    waitingOn: <WaitingOn w={r.standing.waitingOn} />,
    owner: r.standing.owner ? (
      <ActorChip name={r.standing.owner.name ?? "Unknown"} kind={r.standing.owner.kind} size={20} />
    ) : (
      <span className="text-subtle">No owner</span>
    ),
    age: { text: formatAge(r.standing.touchedAt), title: `Last touched ${formatStamp(r.standing.touchedAt)}` },
    dim: r.standing.attentionGroup === "done",
  });

function AssistantStrip({
  projectId,
  rows,
  onPeek,
}: {
  projectId: string;
  rows: RequirementSummary[];
  onPeek: (key: string) => void;
}) {
  const q = useProjectWaitingSuggestions(projectId);
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const open = (q.data?.suggestions ?? []).filter((s) => s.target.type === "requirement" && byId.has(s.target.id));
  if (open.length === 0) return null;
  return (
    <section
      className="border-l-[3px] py-2 pl-[17px] pr-5 text-12-5"
      style={{ background: AGENT_TINT.bg, borderColor: AGENT_TINT.dot }}
      aria-label="BA assistant suggestions"
      data-testid="assistant-strip"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold" style={{ color: AGENT_TINT.fg }}>
          BA assistant
        </span>
        <span className="text-subtle">Suggestions {open.length} · never applied on its own</span>
      </div>
      {open.map((s) => {
        const r = byId.get(s.target.id) as RequirementSummary;
        return <StripRow key={s.id} s={s} r={r} projectId={projectId} onPeek={onPeek} />;
      })}
    </section>
  );
}

function StripRow({ s, r, projectId, onPeek }: { s: Suggestion; r: RequirementSummary; projectId: string; onPeek: (k: string) => void }) {
  const decide = useSuggestionDecision(projectId, requirementAffected(projectId, r.key));
  return (
    <div className="flex flex-wrap items-center gap-2 py-[3px]" data-testid="assistant-strip-row">
      <span className="font-mono text-11-5 font-semibold text-link">{r.key}</span>
      <StatusBadge family="requirement" value={r.standing.state} />
      <span className="min-w-0 truncate">{summaryOf(s)}</span>
      <span className="flex-1" />
      <PendingBadge />
      <Button type="button" size="sm" loading={decide.isPending} onClick={() => decide.mutate({ kind: "accept", id: s.id })}>
        Accept
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => onPeek(r.key)}>
        Review
      </Button>
      {decide.error ? (
        <span className="basis-full">
          <RefusalLine error={decide.error} />
        </span>
      ) : null}
    </div>
  );
}

export function RequirementsScreen({ projectId, slug }: { projectId: string; slug: string }) {
  const q = useRequirements(projectId);
  const router = useRouter();
  const [params, setParams] = useUrlParams();
  const [mode, setMode] = useViewMode(GROUP_MODES);
  const text = params.get("q") ?? "";
  const [creating, setCreating] = useState(false);
  const fold = useGroupFold("web-v2:requirements-fold");

  const all = q.data?.requirements ?? [];
  const rows = useMemo(() => {
    const t = text.trim().toLowerCase();
    return t ? all.filter((r) => `${r.key} ${r.title}`.toLowerCase().includes(t)) : all;
  }, [all, text]);
  const groups = useMemo(() => groupsOf(rows, mode), [rows, mode]);
  const visible = useMemo(() => visibleRows(groups, fold).map((r) => r.key), [groups, fold]);
  const allKeys = useMemo(() => all.map((r) => r.key), [all]);
  const peek = usePeek(visible, allKeys);
  const row = useMemo(() => rowOf(slug), [slug]);

  const openFull = useCallback(
    (key: string) => {
      rememberListOrigin(REQUIREMENTS_LIST);
      router.push(requirementHref(slug, key));
    },
    [router, slug],
  );
  usePeekKeys(peek, openFull);

  const title = (
    <>
      <PageTitle after={<ViewModeSwitcher modes={GROUP_MODES} value={mode} onChange={setMode} placement="header" />}>Requirements</PageTitle>
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

  return (
    <div className="grid min-h-full content-start bg-app" data-testid="requirements-screen">
      {title}
      {creating ? (
        <CreateForm
          projectId={projectId}
          onDone={(key) => {
            setCreating(false);
            if (key) peek.set(key);
          }}
        />
      ) : null}
      <div className={cn("grid min-h-[60vh] items-start", peek.open && "lg:grid-cols-[minmax(0,1fr)_minmax(380px,440px)]")}>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 border-b border-line-subtle px-5 py-2.5 max-md:px-3">
            <ViewModeSwitcher modes={GROUP_MODES} value={mode} onChange={setMode} placement="toolbar" />
            <ListSearch noun="requirements" value={text} onChange={(q) => setParams({ q: q || null })} />
          </div>
          <AssistantStrip projectId={projectId} rows={all} onPeek={(k) => peek.set(k)} />
          {all.length === 0 ? (
            <div className="px-5 py-10">
              <EmptyState title="No requirement has been written" message="A requirement says what is wanted and how anyone can tell it is done." />
            </div>
          ) : (
            <GroupedList
              ariaLabel="Requirements"
              groups={groups}
              fold={fold}
              row={row}
              selected={peek.open}
              onPeek={(k) => peek.set(k === peek.open ? null : k)}
              empty="Nothing matches this search."
            />
          )}
        </div>
        {peek.open ? (
          <RequirementPeek key={peek.open} projectId={projectId} slug={slug} reqKey={peek.open} peek={peek} onOpenFull={() => openFull(peek.open as string)} />
        ) : null}
      </div>
    </div>
  );
}
