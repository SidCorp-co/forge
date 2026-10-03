"use client";

// The Requirements list (`forge-prototype.html` #/requirements): a toolbar with the grouping and a
// search, the BA assistant's open suggestions, then one flush grid grouped by whose turn it is. Each
// row reads core's standing (`requirements/standing.ts`); nothing here derives whose turn it is.
// The URL carries the view (`?group=…&q=…&peek=REQ-n`), so back from the full page restores it.

import {
  REQUIREMENT_ATTENTION_GROUPS,
  REQUIREMENT_ATTENTION_LABELS,
  REQUIREMENT_STATE_LABELS,
  REQUIREMENT_STATE_TONES,
  REQUIREMENT_STATES,
  type StandingTone,
} from "@forge/contracts/requirement-standing";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  Input,
  PageTitle,
  ProjectLoader,
  SegmentedControl,
  Textarea,
  TopBarActions,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { cn } from "@/lib/utils/cn";
import { useCreateRequirement, useProjectSuggestions, useRequirements, useSuggestionDecision } from "../hooks";
import { rememberListOrigin, requirementHref, requirementsHref } from "../routes";
import type { RequirementSummary, Suggestion } from "../types";
import { RequirementPeek } from "./requirement-peek";
import { RefusalLine } from "./refusal";
import { OwnerAge, StateBadge, WaitingOn, revisionText } from "./standing-bits";
import { PendingBadge, summaryOf } from "./suggestions";
import { AI_TINT, TONE } from "./tone";

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

type GroupMode = "attention" | "status";

interface Group {
  id: string;
  label: string;
  hint: string | null;
  tone: StandingTone;
  collapsed: boolean;
  rows: RequirementSummary[];
}

function groupsOf(rows: RequirementSummary[], mode: GroupMode): Group[] {
  if (mode === "status") {
    return REQUIREMENT_STATES.map((s) => ({
      id: s,
      label: REQUIREMENT_STATE_LABELS[s],
      hint: null,
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

// cm:why one grid template for the header and every row, so the columns line up without a table
const COLS = "grid grid-cols-[104px_minmax(0,1fr)_148px_210px_120px] gap-x-3.5 px-5 max-lg:grid-cols-[96px_minmax(0,1fr)_132px_180px]";

function Row({ r, selected, onOpen }: { r: RequirementSummary; selected: boolean; onOpen: () => void }) {
  const dim = r.standing.attentionGroup === "done";
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-pressed={selected}
      data-testid="requirement-row"
      data-key={r.key}
      className={cn(
        COLS,
        "relative min-h-[54px] w-full cursor-pointer items-center border-b border-line-subtle py-[7px] text-left hover:bg-hover",
        "max-md:grid-cols-[auto_minmax(0,1fr)_auto] max-md:gap-y-1 max-md:px-3 max-md:py-2.5",
        selected && "bg-[var(--cobalt-50)] before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-link hover:bg-[var(--cobalt-50)]",
      )}
    >
      <span className={cn("truncate font-mono text-11-5 font-semibold text-link", dim && "opacity-65", "max-md:order-1")}>{r.key}</span>
      <span className="flex min-w-0 flex-col max-md:order-3 max-md:col-span-3">
        <span className={cn("truncate text-13-5 font-medium max-md:whitespace-normal", dim && "opacity-65")}>{r.title}</span>
        <span className="truncate text-12 text-subtle">
          {factsLine(r).map((p, i) => (
            <span key={p}>
              {i > 0 ? <span className="mx-1.5 text-[var(--paper-400)]">·</span> : null}
              {p}
            </span>
          ))}
        </span>
      </span>
      <span className="flex min-w-0 max-md:order-2 max-md:col-span-2 max-md:justify-end">
        <StateBadge state={r.standing.state} />
      </span>
      <span className="flex min-w-0 max-md:order-4 max-md:col-span-2">
        <WaitingOn w={r.standing.waitingOn} />
      </span>
      <span className="flex min-w-0 justify-end max-lg:hidden max-md:order-5 max-md:flex">
        <OwnerAge owner={r.standing.owner} at={r.standing.touchedAt} />
      </span>
    </button>
  );
}

function GroupHeader({ g, open, onToggle }: { g: Group; open: boolean; onToggle: () => void }) {
  const c = g.tone === "neutral" || g.tone === "done" ? "var(--fg-muted)" : TONE[g.tone].fg;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      data-testid="requirement-group"
      data-group={g.id}
      className="sticky top-8 z-[5] flex min-h-[34px] w-full flex-wrap items-center gap-2 bg-sunken px-5 py-[5px] text-left text-13 max-md:top-0 max-md:px-3"
    >
      <Icon name="chevronDown" size={12} className={cn("text-subtle transition-transform duration-150", !open && "-rotate-90")} />
      <span className="font-bold" style={{ color: c }}>
        {g.label}
      </span>
      <span className="font-mono text-12 font-bold" style={{ color: c }}>
        {g.rows.length}
      </span>
      {g.hint ? <span className="text-12 font-medium text-subtle">{g.hint}</span> : null}
    </button>
  );
}

function AssistantStrip({
  projectId,
  rows,
  onPeek,
}: {
  projectId: string;
  rows: RequirementSummary[];
  onPeek: (key: string) => void;
}) {
  const q = useProjectSuggestions(projectId);
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const open = (q.data?.suggestions ?? []).filter((s) => s.target.type === "requirement" && byId.has(s.target.id));
  if (open.length === 0) return null;
  return (
    <section
      className="border-l-[3px] py-2 pl-[17px] pr-5 text-12-5"
      style={{ background: AI_TINT.bg, borderColor: AI_TINT.bar }}
      aria-label="BA assistant suggestions"
      data-testid="assistant-strip"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold" style={{ color: AI_TINT.fg }}>
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
  const decide = useSuggestionDecision(projectId, r.key);
  return (
    <div className="flex flex-wrap items-center gap-2 py-[3px]" data-testid="assistant-strip-row">
      <span className="font-mono text-11-5 font-semibold text-link">{r.key}</span>
      <StateBadge state={r.standing.state} />
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

const GROUP_OPTIONS = [
  { value: "attention" as const, label: "Attention" },
  { value: "status" as const, label: "Status" },
];

export function RequirementsScreen({ projectId, slug }: { projectId: string; slug: string }) {
  const q = useRequirements(projectId);
  const router = useRouter();
  // cm:why Next syncs useSearchParams with window.history.replaceState, so a view change writes the
  // URL without a navigation and still re-renders; back from the full page lands on that URL
  const sp = useSearchParams();
  const mode: GroupMode = sp.get("group") === "status" ? "status" : "attention";
  const text = sp.get("q") ?? "";
  const peek = sp.get("peek");
  const [creating, setCreating] = useState(false);
  const [folded, setFolded] = useState<Record<string, boolean>>({});

  const setParams = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(window.location.search);
      for (const [k, v] of Object.entries(patch)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      const qs = next.toString();
      window.history.replaceState(null, "", `${requirementsHref(slug)}${qs ? `?${qs}` : ""}`);
    },
    [slug],
  );

  const all = q.data?.requirements ?? [];
  const rows = useMemo(() => {
    const t = text.trim().toLowerCase();
    return t ? all.filter((r) => `${r.key} ${r.title}`.toLowerCase().includes(t)) : all;
  }, [all, text]);
  const groups = useMemo(() => groupsOf(rows, mode).filter((g) => g.rows.length > 0), [rows, mode]);
  const isOpen = useCallback((g: Group) => !(folded[`${mode}:${g.id}`] ?? g.collapsed), [folded, mode]);
  const visible = useMemo(() => groups.flatMap((g) => (isOpen(g) ? g.rows : [])), [groups, isOpen]);
  const open = peek && all.some((r) => r.key === peek) ? peek : null;

  const openFull = useCallback(
    (key: string) => {
      rememberListOrigin();
      router.push(requirementHref(slug, key));
    },
    [router, slug],
  );
  const move = useCallback(
    (by: number) => {
      const i = visible.findIndex((r) => r.key === open);
      const next = visible[i + by];
      if (next) setParams({ peek: next.key });
    },
    [visible, open, setParams],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.key === "Escape") setParams({ peek: null });
      else if (e.key === "j") move(1);
      else if (e.key === "k") move(-1);
      else if (e.key === "Enter" && e.target === document.body) openFull(open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, move, openFull, setParams]);

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
  const index = open ? visible.findIndex((r) => r.key === open) : -1;

  return (
    <div className="grid min-h-full content-start bg-surface" data-testid="requirements-screen">
      {title}
      {creating ? (
        <CreateForm
          projectId={projectId}
          onDone={(key) => {
            setCreating(false);
            if (key) setParams({ peek: key });
          }}
        />
      ) : null}
      <div className={cn("grid min-h-[60vh] items-start", open && "lg:grid-cols-[minmax(0,1fr)_minmax(380px,440px)]")}>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 border-b border-line-subtle px-5 py-2.5 max-md:px-3">
            <span className="text-12 font-semibold text-subtle">Group</span>
            <SegmentedControl options={GROUP_OPTIONS} value={mode} onChange={(v) => setParams({ group: v === "attention" ? null : v })} />
            <label className="flex h-[30px] min-w-[150px] max-w-[260px] flex-1 items-center gap-1.5 rounded-sm border border-line bg-surface px-2.5 text-12-5 text-subtle max-md:h-10 max-md:max-w-none max-md:basis-full">
              <Icon name="search" size={14} />
              <input
                type="search"
                aria-label="Search requirements"
                placeholder="Search requirements…"
                defaultValue={text}
                onChange={(e) => setParams({ q: e.target.value || null })}
                className="w-full min-w-0 border-0 bg-transparent text-fg outline-none"
              />
            </label>
          </div>
          <AssistantStrip projectId={projectId} rows={all} onPeek={(k) => setParams({ peek: k })} />
          {all.length === 0 ? (
            <div className="px-5 py-10">
              <EmptyState title="No requirement has been written" message="A requirement says what is wanted and how anyone can tell it is done." />
            </div>
          ) : (
            <section aria-label="Requirements">
              <div
                aria-hidden
                className={cn(COLS, "sticky top-0 z-[6] h-8 items-center border-b border-line-subtle bg-app text-11-5 font-semibold text-subtle max-md:hidden")}
              >
                <span>Key</span>
                <span>Title</span>
                <span>State</span>
                <span>Waiting on</span>
                <span className="text-right max-lg:hidden">Owner · age</span>
              </div>
              {groups.length === 0 ? <p className="px-5 py-8 text-13 text-subtle">Nothing matches this search.</p> : null}
              {groups.map((g) => {
                const shown = isOpen(g);
                return (
                  <div key={`${mode}:${g.id}`}>
                    <GroupHeader g={g} open={shown} onToggle={() => setFolded((f) => ({ ...f, [`${mode}:${g.id}`]: shown }))} />
                    {shown
                      ? g.rows.map((r) => (
                          <Row key={r.id} r={r} selected={r.key === open} onOpen={() => setParams({ peek: r.key === open ? null : r.key })} />
                        ))
                      : null}
                  </div>
                );
              })}
            </section>
          )}
        </div>
        {open ? (
          <RequirementPeek
            key={open}
            projectId={projectId}
            slug={slug}
            reqKey={open}
            position={index >= 0 ? { at: index + 1, of: visible.length } : null}
            onMove={move}
            onClose={() => setParams({ peek: null })}
            onOpenFull={() => openFull(open)}
          />
        ) : null}
      </div>
    </div>
  );
}
