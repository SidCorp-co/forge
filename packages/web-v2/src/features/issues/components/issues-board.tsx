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
import { type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  EmptyState,
  GroupedList,
  ListSearch,
  LEGEND,
  type LegendTone,
  type ListGroup,
  rememberListOrigin,
  SegmentedControl,
  sortGroupsBy,
  useGroupFold,
  usePeek,
  usePeekKeys,
  useUrlParams,
  visibleRows,
} from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy, useLabel } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { cn } from "@/lib/utils/cn";
import { useIssueStanding } from "../hooks";
import { ISSUES_LIST, issueHref } from "@/lib/routes/issues";
import { statusesFromParam } from "../derive";
import { issueBadge, issueEta, issueRowView, useRowWords } from "./issue-standing-bits";
import { IssuePeek } from "./issue-peek";
import { useEtaClock, useEtaSort, useProjectForecast } from "@/features/forecast/hooks";
import { etaSortValue } from "@/features/forecast/eta";
import { ETA_COPY } from "@/features/forecast/eta-copy";
import { Written } from "@/lib/i18n/written";

type BoardMode = "attention" | "module" | "waves";

const QUICK = [
  { id: "you", mono: false },
  { id: "blocked", mono: true },
  { id: "blocking", mono: true },
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

function attentionGroups(rows: IssueStandingRow[], t: Copy): ListGroup<IssueStandingRow>[] {
  return ISSUE_ATTENTION_GROUPS.map((g) => ({
    id: g,
    ...ISSUE_ATTENTION_LABELS[g],
    label: t(`issues.attention.${g}`),
    hint: t(`issues.attention.${g}.hint`),
    rows: rows.filter((r) => r.standing.attentionGroup === g),
  }));
}

const SUMMARY_GROUPS = ["needs_you", "moving", "stuck"] as const;

function moduleGroups(rows: IssueStandingRow[], t: Copy): ListGroup<IssueStandingRow>[] {
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
      label: path || t("issues.board.noModule"),
      mono: Boolean(path),
      summary: SUMMARY_GROUPS.map((g) => ({
        label: t(`issues.attention.${g}`),
        count: list.filter((r) => r.standing.attentionGroup === g).length,
        tone: ISSUE_ATTENTION_LABELS[g].tone,
      })).filter((s) => s.count > 0),
      rows: list,
    };
  });
}

const waveNote = (t: Copy, l: number): string =>
  l === 0 ? t("issues.wave.note0") : l === 1 ? t("issues.wave.note1") : l === 2 ? t("issues.wave.note2") : t("issues.wave.noteN", { n: l });

/** The blocks edges between the visible wave cards, blocker first. */
function waveEdges(rows: readonly IssueStandingRow[]): { from: string; to: string }[] {
  const shown = new Set(rows.filter((r) => r.standing.wave !== null).map((r) => r.key));
  return rows.flatMap((r) => (shown.has(r.key) ? r.standing.blockedBy.filter((b) => shown.has(b.key)).map((b) => ({ from: b.key, to: r.key })) : []));
}

interface EdgePath {
  id: string;
  d: string;
}

/** Each edge as a curve from the blocker card's right edge to the dependent's left, in the
 *  container's own coordinates; re-measured whenever the container or a card changes size. */
function useEdgePaths(edges: readonly { from: string; to: string }[]) {
  const ref = useRef<HTMLDivElement>(null);
  const [paths, setPaths] = useState<EdgePath[]>([]);
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const measure = () => {
      const origin = box.getBoundingClientRect();
      const at = (key: string) => box.querySelector<HTMLElement>(`[data-testid="wave-card"][data-key="${CSS.escape(key)}"]`)?.getBoundingClientRect();
      const next: EdgePath[] = [];
      for (const e of edges) {
        const a = at(e.from);
        const b = at(e.to);
        if (!a || !b) continue;
        const x1 = a.right - origin.left;
        const y1 = a.top + a.height / 2 - origin.top;
        const x2 = b.left - origin.left;
        const y2 = b.top + b.height / 2 - origin.top;
        const dx = Math.max(16, (x2 - x1) / 2);
        next.push({ id: `${e.from}>${e.to}`, d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}` });
      }
      setPaths(next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    for (const el of box.querySelectorAll('[data-testid="wave-card"]')) ro.observe(el);
    return () => ro.disconnect();
  }, [edges]);
  return { ref, paths };
}

/** One column per wave, as wide as the screen allows; a card's left edge is its attention tone and
 *  a line runs from each blocker to what it holds back. Wave 0 splits the chain roots from the
 *  issues that block nothing. */
function Waves({ rows, onPeek, selected }: { rows: IssueStandingRow[]; onPeek: (k: string) => void; selected: string | null }) {
  const inWave = rows.filter((r) => r.standing.wave !== null);
  const outside = rows.length - inWave.length;
  const max = Math.max(-1, ...inWave.map((r) => r.standing.wave as number));
  const rank = (r: IssueStandingRow) => ISSUE_ATTENTION_GROUPS.indexOf(r.standing.attentionGroup);
  const edges = useMemo(() => waveEdges(rows), [rows]);
  const { ref, paths } = useEdgePaths(edges);
  const t = useCopy();
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
          "relative z-[1] grid w-full gap-1 border-b border-line-subtle bg-app py-2.5 pl-3 pr-2.5 text-left hover:bg-hover",
          selected === r.key && "bg-[var(--cobalt-50)] hover:bg-[var(--cobalt-50)]",
        )}
        style={{ borderLeft: `3px solid ${LEGEND[tone].dot}` }}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="font-mono text-12 font-semibold text-link">{r.key}</span>
          {issueBadge(r)}
        </span>
        <Written className={cn("text-13 font-medium text-fg", compact ? "truncate" : "line-clamp-2")} text={r.title} lang={r.writtenLang} />
        {compact ? null : (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-11-5 text-subtle">
            {r.standing.module ? <span className="font-mono underline decoration-dotted underline-offset-2">{r.standing.module.path}</span> : null}
            {r.standing.attentionGroup === "needs_you" ? (
              <span className="rounded-sm px-1.5" style={{ color: LEGEND.you.fg, background: LEGEND.you.bg }}>
                {t("issues.board.waitingOnYou")}
              </span>
            ) : null}
            {r.standing.blocks.length > 1 ? <span>{t("issues.deps.blocks", { n: r.standing.blocks.length })}</span> : null}
          </span>
        )}
        {r.standing.blockedBy.length > 0 ? <span className="sr-only">{t("issues.board.waitsOnKeys", { keys: r.standing.blockedBy.map((b) => b.key).join(", ") })}</span> : null}
      </button>
    );
  };
  if (inWave.length === 0) return <p className="px-5 py-8 text-13 text-subtle">{t("issues.wave.none")}</p>;
  return (
    <section aria-label={t("issues.mode.waves")} data-testid="waves">
      <div className="overflow-x-auto">
        <div
          ref={ref}
          className="relative grid gap-x-12 px-5 pb-6 pt-5 max-md:gap-x-8 max-md:px-3"
          style={{ gridTemplateColumns: `repeat(${max + 1}, minmax(260px, 1fr))` }}
        >
          <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" data-testid="wave-edges">
            {paths.map((p) => (
              <path key={p.id} d={p.d} fill="none" stroke="var(--fg-subtle)" strokeWidth={1.25} opacity={0.7} data-edge={p.id} />
            ))}
          </svg>
          {Array.from({ length: max + 1 }, (_, l) => {
            const col = inWave.filter((r) => r.standing.wave === l).sort((a, b) => rank(a) - rank(b));
            const roots = col.filter((r) => r.standing.blocks.length > 0);
            const solo = col.filter((r) => r.standing.blocks.length === 0);
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: a wave is its index
              <div key={l} className="min-w-0" data-testid="wave" data-wave={l}>
                <h3 className="text-13 font-bold text-fg">
                  {t("issues.wave.title", { n: l })} <span className="font-normal text-muted">· {col.length}</span>
                </h3>
                <p className="mb-3 mt-0.5 text-12 text-subtle">{waveNote(t, l)}</p>
                {l === 0 ? (
                  <>
                    {roots.length > 0 ? <p className="mb-1.5 text-12 font-semibold text-muted">{t("issues.wave.roots", { n: roots.length })}</p> : null}
                    <div className="border-t border-line-subtle">{roots.map((r) => card(r))}</div>
                    {solo.length > 0 ? <p className="mb-1.5 mt-4 text-12 font-semibold text-muted">{t("issues.wave.solo", { n: solo.length })}</p> : null}
                    <div className="border-t border-line-subtle">{solo.map((r) => card(r, true))}</div>
                  </>
                ) : (
                  <div className="border-t border-line-subtle">{col.map((r) => card(r))}</div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line-subtle px-5 py-2.5 text-12 text-muted" data-testid="waves-legend">
        {(
          [
            ["you", t("issues.board.waitingOnYou")],
            ["run", t("issues.wave.legendRun")],
            ["blocked", t("issues.attention.stuck")],
            ["ready", t("issues.wave.legendQueued")],
            ["neutral", t("issues.attention.paused")],
          ] as [LegendTone, string][]
        ).map(([tone, l]) => (
          <span key={tone} className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-[3px] w-3 rounded-pill" style={{ background: LEGEND[tone].dot }} />
            {l}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-px w-4" style={{ background: "var(--fg-subtle)" }} />
          {t("issues.rail.blocks")}
        </span>
        {outside > 0 ? <span>{t("issues.wave.outside", { n: outside })}</span> : null}
      </div>
    </section>
  );
}

function Toolbar({ data, scope, n, children }: { data: IssueStandingList | undefined; scope: IssueStandingScope; n: Narrowing; children?: ReactNode }) {
  const [, set] = useUrlParams();
  const t = useCopy();
  const quickLabel: Record<Quick, string> = { you: t("issues.board.waitingOnYou"), blocked: t("issues.board.quickBlocked"), blocking: t("issues.board.quickBlocking") };
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
        options={ISSUE_STANDING_SCOPES.map((s) => ({ value: s, label: t(`issues.segment.${s}`), count: counts?.[s] }))}
        value={scope}
        onChange={(v) => set({ filter: v === "open" ? null : v, peek: null })}
      />
      <ListSearch noun={t("issues.board.searchNoun")} value={n.q} onChange={(q) => set({ q: q || null })} />
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
            <span className={c.mono ? "font-mono text-12" : undefined}>{quickLabel[c.id]}</span>
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
  const t = useCopy();
  const L = useLabel();
  const parts = [
    n.statuses.length ? `${t("issues.field.status")} ${n.statuses.map((s) => L("issueStatus", s)).join(", ")}` : null,
    n.priority ? `${t("issues.field.priority")} ${L("issuePriority", n.priority)}` : null,
    n.createdBy ? t("issues.board.createdByYou") : null,
    n.assignee ? t("issues.board.assignedToYou") : null,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line-subtle bg-app px-5 py-1.5 text-12-5 text-muted" data-testid="issues-narrowed">
      <span>{t("issues.board.narrowed", { parts: parts.join(" · ") })}</span>
      <button type="button" className="font-semibold text-link hover:underline" onClick={() => set({ status: null, priority: null, createdBy: null, assignee: null })}>
        {t("issues.toolbar.clear")}
      </button>
    </div>
  );
}

export function IssuesBoard({ scope: project, mode, toolbarLead }: { scope: { projectId: string; slug: string }; mode: BoardMode; toolbarLead?: ReactNode }) {
  const router = useRouter();
  const [params] = useUrlParams();
  const t = useCopy();
  const words = useRowWords();
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
  const forecastQ = useProjectForecast(project.projectId);
  const forecasts = useMemo(() => new Map((forecastQ.data?.issues ?? []).map((i) => [i.key, i.forecast])), [forecastQ.data]);
  const clock = useEtaClock();
  const [etaSorted, toggleEtaSort] = useEtaSort();
  const etaOf = useCallback((k: string) => issueEta(forecasts.get(k), clock), [forecasts, clock]);
  const groups = useMemo(() => {
    const plain = mode === "module" ? moduleGroups(rows, t) : attentionGroups(rows, t);
    return etaSorted ? sortGroupsBy(plain, (r) => etaSortValue(etaOf(r.key))) : plain;
  }, [rows, mode, etaSorted, etaOf, t]);
  const fold = useGroupFold(`web-v2:issues-fold:${mode}`);
  const visible = useMemo(
    () => (mode === "waves" ? rows.filter((r) => r.standing.wave !== null).map((r) => r.key) : visibleRows(groups, fold).map((r) => r.key)),
    [mode, rows, groups, fold],
  );
  const allKeys = useMemo(() => (q.data?.issues ?? []).map((r) => r.key), [q.data]);
  const peek = usePeek(visible, allKeys);
  const row = useMemo(() => issueRowView(project.slug, words, { of: etaOf, clock }), [project.slug, words, etaOf, clock]);
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
    <div className="grid min-h-full content-start bg-app" data-testid="issues-board" data-mode={mode}>
      <div className={cn("grid min-h-[60vh] items-start", openRow && "lg:grid-cols-[minmax(0,1fr)_minmax(380px,440px)]")}>
        <div className="min-w-0">
          <Toolbar data={q.data} scope={scope} n={n}>
            {toolbarLead}
          </Toolbar>
          <AssistantNarrowing n={n} />
          {truncated ? (
            <p className="border-b border-line-subtle bg-app px-5 py-1.5 text-12-5 text-muted" data-testid="issues-truncated">
              {t("issues.board.truncated", { shown: q.data?.returned ?? 0, total: q.data?.counts[scope] ?? 0 })}
            </p>
          ) : null}
          <QueryBoundary query={q} loadingLabel={t("issues.board.loading")} retry="always">
            {(data) =>
              data.issues.length === 0 ? (
                <div className="px-5 py-10">
                  <EmptyState title={scope === "closed" ? t("issues.board.noClosed") : t("issues.board.noIssue")} message={t("issues.board.emptyHint")} />
                </div>
              ) : mode === "waves" ? (
                <Waves rows={rows} selected={peek.open} onPeek={(k) => peek.set(k === peek.open ? null : k)} />
              ) : (
                <GroupedList
                  ariaLabel={t("issues.screen.title")}
                  groups={groups}
                  fold={fold}
                  row={row}
                  eta={{ label: ETA_COPY[clock.lang].header, sortLabel: ETA_COPY[clock.lang].sortBy, sorted: etaSorted, onSort: toggleEtaSort }}
                  selected={peek.open}
                  onPeek={(k) => peek.set(k === peek.open ? null : k)}
                  empty={t("issues.board.noMatch")}
                />
              )
            }
          </QueryBoundary>
        </div>
        {openRow ? <IssuePeek key={openRow.key} slug={project.slug} row={openRow} forecast={forecasts.get(openRow.key)} clock={clock} peek={peek} onOpenFull={() => openFull(openRow.key)} /> : null}
      </div>
    </div>
  );
}
