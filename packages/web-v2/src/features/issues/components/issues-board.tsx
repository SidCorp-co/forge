"use client";

// The grouped Issues views (`forge-prototype.html` #/dev/issues): Attention (whose turn), Module (by
// primary module) and Waves (by layers of open blockers), over core's read model
// (`GET /projects/:id/issues/standing`). The toolbar holds the scope, a search and three quick
// filters; the assistant's `ui.issues.filter` params (status, priority, createdBy, assignee) narrow
// these views the same way they narrow the Table. The URL is the state, so back from a full page
// lands on the same view, filters and peek.

import {
  ISSUE_ATTENTION_GROUPS,
  ISSUE_ATTENTION_LABELS,
  ISSUE_STANDING_SCOPES,
  type IssueStandingList,
  type IssueStandingRow,
  type IssueStandingScope,
} from "@forge/contracts/issue-standing";
import { useRouter } from "next/navigation";
import { type ReactNode, useCallback, useMemo } from "react";
import {
  EmptyState,
  ErrorState,
  GroupedList,
  Icon,
  LEGEND,
  type LegendTone,
  type ListGroup,
  ProjectLoader,
  rememberListOrigin,
  SegmentedControl,
  useGroupFold,
  usePeek,
  usePeekKeys,
  useUrlParams,
  visibleRows,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { cn } from "@/lib/utils/cn";
import { useIssueStanding } from "../hooks";
import { ISSUES_LIST, issueHref } from "../routes";
import { priorityLabel, statusesFromParam, statusLabel } from "../derive";
import { issueBadge, issueRowView } from "./issue-standing-bits";
import { IssuePeek } from "./issue-peek";

export type BoardMode = "attention" | "module" | "waves";

const QUICK = [
  { id: "you", label: "Waiting on you", mono: false },
  { id: "blocked", label: "is:blocked", mono: true },
  { id: "blocking", label: "is:blocking", mono: true },
] as const;
type Quick = (typeof QUICK)[number]["id"];

const scopeOf = (raw: string | null): IssueStandingScope =>
  (ISSUE_STANDING_SCOPES as readonly string[]).includes(raw ?? "") ? (raw as IssueStandingScope) : "open";

interface Narrowing {
  q: string;
  quick: Set<Quick>;
  statuses: string[];
  priority: string;
  createdBy: string;
  assignee: string;
}

function narrow(rows: IssueStandingRow[], n: Narrowing): IssueStandingRow[] {
  const t = n.q.trim().toLowerCase();
  return rows.filter((r) => {
    if (t && !`${r.key} ${r.title}`.toLowerCase().includes(t)) return false;
    if (n.quick.has("you") && r.standing.attentionGroup !== "needs_you") return false;
    if (n.quick.has("blocked") && r.standing.blockedBy.length === 0) return false;
    if (n.quick.has("blocking") && r.standing.blocks.length === 0) return false;
    if (n.statuses.length && !n.statuses.includes(r.status)) return false;
    if (n.priority && r.priority !== n.priority) return false;
    if (n.createdBy && r.createdById !== n.createdBy) return false;
    if (n.assignee && r.assigneeId !== n.assignee) return false;
    return true;
  });
}

function attentionGroups(rows: IssueStandingRow[]): ListGroup<IssueStandingRow>[] {
  return ISSUE_ATTENTION_GROUPS.map((g) => ({ id: g, ...ISSUE_ATTENTION_LABELS[g], rows: rows.filter((r) => r.standing.attentionGroup === g) }));
}

const SUMMARY_GROUPS = ["needs_you", "moving", "stuck"] as const;

function moduleGroups(rows: IssueStandingRow[]): ListGroup<IssueStandingRow>[] {
  const by = new Map<string, IssueStandingRow[]>();
  for (const r of rows) {
    const path = r.standing.module?.path ?? "";
    by.set(path, [...(by.get(path) ?? []), r]);
  }
  const paths = [...by.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  return paths.map((path) => {
    const list = by.get(path) ?? [];
    return {
      id: `module:${path || "none"}`,
      label: path || "No module",
      mono: Boolean(path),
      summary: SUMMARY_GROUPS.map((g) => ({
        label: ISSUE_ATTENTION_LABELS[g].label,
        count: list.filter((r) => r.standing.attentionGroup === g).length,
        tone: ISSUE_ATTENTION_LABELS[g].tone,
      })).filter((s) => s.count > 0),
      rows: list,
    };
  });
}

const WAVE_NOTE = [
  "No open blocker: running, ready, or waiting on a person",
  "Waits on one layer of blockers",
  "Waits on two layers",
];

/** One column per wave; a card's left edge is its attention tone. Wave 0 splits the chain roots from the issues that block nothing. */
function Waves({ rows, onPeek, selected }: { rows: IssueStandingRow[]; onPeek: (k: string) => void; selected: string | null }) {
  const inWave = rows.filter((r) => r.standing.wave !== null);
  const outside = rows.length - inWave.length;
  const max = Math.max(-1, ...inWave.map((r) => r.standing.wave as number));
  const rank = (r: IssueStandingRow) => ISSUE_ATTENTION_GROUPS.indexOf(r.standing.attentionGroup);
  const card = (r: IssueStandingRow, compact?: boolean) => {
    const tone = ISSUE_ATTENTION_LABELS[r.standing.attentionGroup].tone;
    return (
      <button
        key={r.key}
        type="button"
        onClick={() => onPeek(r.key)}
        aria-current={selected === r.key ? "true" : undefined}
        data-testid="wave-card"
        data-key={r.key}
        className={cn(
          "grid w-full gap-1 border-b border-line-subtle bg-surface py-2 pl-3 pr-2.5 text-left hover:bg-hover",
          selected === r.key && "bg-[var(--cobalt-50)] hover:bg-[var(--cobalt-50)]",
        )}
        style={{ borderLeft: `3px solid ${LEGEND[tone].dot}` }}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="font-mono text-11-5 font-semibold text-link">{r.key}</span>
          {issueBadge(r)}
        </span>
        <span className={cn("text-13 font-medium", compact ? "truncate" : "line-clamp-2")}>{r.title}</span>
        {compact ? null : (
          <span className="flex flex-wrap gap-x-2 gap-y-0.5 text-11-5 text-subtle">
            {r.standing.module ? <span className="font-mono">{r.standing.module.path}</span> : null}
            {r.standing.attentionGroup === "needs_you" ? <span style={{ color: LEGEND.you.fg }}>Waiting on you</span> : null}
            {r.standing.blocks.length > 1 ? <span>Blocks {r.standing.blocks.length}</span> : null}
            {r.standing.blockedBy.map((b) => (
              <span key={b.key}>Waits on {b.key}</span>
            ))}
          </span>
        )}
      </button>
    );
  };
  if (inWave.length === 0) return <p className="px-5 py-8 text-13 text-subtle">No open issue sits in a wave.</p>;
  return (
    <section aria-label="Waves" data-testid="waves">
      <div className="flex gap-0 overflow-x-auto">
        {Array.from({ length: max + 1 }, (_, l) => {
          const col = inWave.filter((r) => r.standing.wave === l).sort((a, b) => rank(a) - rank(b));
          const roots = col.filter((r) => r.standing.blocks.length > 0);
          const solo = col.filter((r) => r.standing.blocks.length === 0);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: a wave is its index
            <div key={l} className="min-w-[260px] max-w-[320px] flex-1 border-r border-line-subtle" data-testid="wave" data-wave={l}>
              <div className="sticky top-0 z-[2] border-b border-line-subtle bg-sunken px-3 py-2">
                <h3 className="text-13 font-bold text-fg">
                  Wave {l} <span className="font-mono text-12 text-muted">{col.length}</span>
                </h3>
                <p className="text-11-5 text-subtle">{WAVE_NOTE[l] ?? `Waits on ${l} layers`}</p>
              </div>
              {l === 0 ? (
                <>
                  <p className="bg-app px-3 py-1 text-11-5 font-semibold text-muted">Chain roots {roots.length}</p>
                  {roots.map((r) => card(r))}
                  <p className="bg-app px-3 py-1 text-11-5 font-semibold text-muted">Independent, blocks nothing {solo.length}</p>
                  {solo.map((r) => card(r, true))}
                </>
              ) : (
                col.map((r) => card(r))
              )}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line-subtle px-5 py-2 text-12 text-muted" data-testid="waves-legend">
        {(
          [
            ["you", "Waiting on you"],
            ["run", "Running, live lease"],
            ["blocked", "Stuck"],
            ["ready", "Queued for a master"],
            ["neutral", "Paused"],
          ] as [LegendTone, string][]
        ).map(([t, l]) => (
          <span key={t} className="inline-flex items-center gap-1.5">
            <span aria-hidden className="size-2 rounded-[2px]" style={{ background: LEGEND[t].dot }} />
            {l}
          </span>
        ))}
        {outside > 0 ? <span>Not in a wave {outside}: done, or in a blocking cycle</span> : null}
      </div>
    </section>
  );
}

function Toolbar({ data, scope, n, children }: { data: IssueStandingList | undefined; scope: IssueStandingScope; n: Narrowing; children?: ReactNode }) {
  const [, set] = useUrlParams();
  const toggle = (id: Quick) => {
    const next = new Set(n.quick);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set({ f: [...next].join(",") || null });
  };
  const counts = data?.counts;
  const quickCount: Record<Quick, number | undefined> = { you: counts?.needsYou, blocked: counts?.blocked, blocking: counts?.blocking };
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line-subtle px-5 py-2.5 max-md:px-3" data-testid="issues-toolbar">
      {children}
      <SegmentedControl
        options={ISSUE_STANDING_SCOPES.map((s) => ({ value: s, label: s === "open" ? "Open" : s === "closed" ? "Closed" : "All", count: counts?.[s] }))}
        value={scope}
        onChange={(v) => set({ filter: v === "open" ? null : v, peek: null })}
      />
      <label className="flex h-[30px] min-w-[150px] max-w-[260px] flex-1 items-center gap-1.5 rounded-sm border border-line bg-surface px-2.5 text-12-5 text-subtle max-md:h-10 max-md:max-w-none max-md:basis-full">
        <Icon name="search" size={14} />
        <input
          type="search"
          aria-label="Search issues"
          placeholder="Search issues…"
          defaultValue={n.q}
          onChange={(e) => set({ q: e.target.value || null })}
          className="w-full min-w-0 border-0 bg-transparent text-fg outline-none"
        />
      </label>
      {QUICK.map((c) => {
        const on = n.quick.has(c.id);
        return (
          <button
            key={c.id}
            type="button"
            aria-pressed={on}
            onClick={() => toggle(c.id)}
            data-testid={`quick-${c.id}`}
            className={cn(
              "inline-flex h-[30px] items-center gap-1.5 rounded-pill border px-2.5 text-12-5 font-semibold",
              on ? "border-link bg-[var(--cobalt-50)] text-fg" : "border-line bg-surface text-muted hover:text-fg",
            )}
          >
            <span className={c.mono ? "font-mono text-12" : undefined}>{c.label}</span>
            {quickCount[c.id] !== undefined ? (
              <span className="rounded-full px-1.5 text-11 tabular-nums" style={c.id === "you" && quickCount[c.id] ? { background: LEGEND.you.bg, color: LEGEND.you.fg } : undefined}>
                {quickCount[c.id]}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** The assistant's narrowing, said in words with a way to drop it, so a filtered view never passes for the whole list. */
function AssistantNarrowing({ n }: { n: Narrowing }) {
  const [, set] = useUrlParams();
  const parts = [
    n.statuses.length ? `Status ${n.statuses.map((s) => statusLabel(s as never)).join(", ")}` : null,
    n.priority ? `Priority ${priorityLabel(n.priority as never)}` : null,
    n.createdBy ? "Created by you" : null,
    n.assignee ? "Assigned to you" : null,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line-subtle bg-app px-5 py-1.5 text-12-5 text-muted" data-testid="issues-narrowed">
      <span>Narrowed: {parts.join(" · ")}</span>
      <button type="button" className="font-semibold text-link hover:underline" onClick={() => set({ status: null, priority: null, createdBy: null, assignee: null })}>
        Clear
      </button>
    </div>
  );
}

export function IssuesBoard({ scope: project, mode, toolbarLead }: { scope: { projectId: string; slug: string }; mode: BoardMode; toolbarLead?: ReactNode }) {
  const router = useRouter();
  const [params] = useUrlParams();
  const scope = scopeOf(params.get("filter"));
  const q = useIssueStanding(project.projectId, scope);
  const n: Narrowing = {
    q: params.get("q") ?? "",
    quick: new Set((params.get("f") ?? "").split(",").filter((x): x is Quick => QUICK.some((c) => c.id === x))),
    statuses: statusesFromParam(params.get("status")) ?? [],
    priority: params.get("priority") ?? "",
    createdBy: params.get("createdBy") ?? "",
    assignee: params.get("assignee") ?? "",
  };
  const key = `${n.q}|${[...n.quick].join()}|${n.statuses.join()}|${n.priority}|${n.createdBy}|${n.assignee}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for every narrowing field
  const rows = useMemo(() => narrow(q.data?.issues ?? [], n), [q.data, key]);
  const groups = useMemo(() => (mode === "module" ? moduleGroups(rows) : attentionGroups(rows)), [rows, mode]);
  const fold = useGroupFold(`web-v2:issues-fold:${mode}`);
  const visible = useMemo(
    () => (mode === "waves" ? rows.filter((r) => r.standing.wave !== null).map((r) => r.key) : visibleRows(groups, fold).map((r) => r.key)),
    [mode, rows, groups, fold],
  );
  const allKeys = useMemo(() => (q.data?.issues ?? []).map((r) => r.key), [q.data]);
  const peek = usePeek(visible, allKeys);
  const row = useMemo(() => issueRowView(project.slug), [project.slug]);
  const openFull = useCallback(
    (k: string) => {
      rememberListOrigin(ISSUES_LIST);
      router.push(issueHref(project.slug, k));
    },
    [router, project.slug],
  );
  usePeekKeys(peek, openFull);
  const openRow = q.data?.issues.find((r) => r.key === peek.open) ?? null;
  const truncated = q.data && q.data.returned >= q.data.limit && q.data.counts[scope] > q.data.returned;

  return (
    <div className="grid min-h-full content-start bg-surface" data-testid="issues-board" data-mode={mode}>
      <div className={cn("grid min-h-[60vh] items-start", openRow && "lg:grid-cols-[minmax(0,1fr)_minmax(380px,440px)]")}>
        <div className="min-w-0">
          <Toolbar data={q.data} scope={scope} n={n}>
            {toolbarLead}
          </Toolbar>
          <AssistantNarrowing n={n} />
          {truncated ? (
            <p className="border-b border-line-subtle bg-app px-5 py-1.5 text-12-5 text-muted" data-testid="issues-truncated">
              Showing the newest {q.data?.returned} of {q.data?.counts[scope]}; the Table view pages through every one.
            </p>
          ) : null}
          {q.isLoading ? (
            <div className="grid min-h-[40vh] place-items-center">
              <ProjectLoader label="loading issues…" />
            </div>
          ) : q.isError || !q.data ? (
            <div className="grid min-h-[40vh] place-items-center">
              <ErrorState message={formatApiError(q.error)} onRetry={() => q.refetch()} />
            </div>
          ) : q.data.issues.length === 0 ? (
            <div className="px-5 py-10">
              <EmptyState title={scope === "closed" ? "No closed issue yet" : "No issue here"} message="An issue is one unit of work with a named deliverable." />
            </div>
          ) : mode === "waves" ? (
            <Waves rows={rows} selected={peek.open} onPeek={(k) => peek.set(k === peek.open ? null : k)} />
          ) : (
            <GroupedList
              ariaLabel="Issues"
              groups={groups}
              fold={fold}
              row={row}
              selected={peek.open}
              onPeek={(k) => peek.set(k === peek.open ? null : k)}
              empty="Nothing matches these filters."
            />
          )}
        </div>
        {openRow ? <IssuePeek key={openRow.key} slug={project.slug} row={openRow} peek={peek} onOpenFull={() => openFull(openRow.key)} /> : null}
      </div>
    </div>
  );
}
