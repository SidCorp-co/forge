"use client";

// cm:why Agents / Runs (ISS-111, prototype #/dev/runs, design agent-run-standing rev 1): the signals line,
// the project master row and every run grouped by core's attentionGroup (or by lane or box), a peek and a
// full page per row, all read from GET /runs/standing; the band and the list read the same answer, so
// they can never disagree about how many runs there are
import { RUN_GROUP_LABELS, RUN_MASTER_GROUP, RUN_STANDING_SCOPES, type RunStandingScope } from "@forge/contracts/run-standing";
import { needsViewer } from "@forge/contracts/standing";
import { useRouter } from "next/navigation";
import { useCallback, useMemo } from "react";
import {
  ErrorState,
  FilterChip,
  GroupedList,
  type ListGroup,
  ListSearch,
  ProjectLoader,
  rememberListOrigin,
  SegmentedControl,
  Signal,
  SignalsStrip,
  StatusBadge,
  useGroupFold,
  usePeek,
  usePeekKeys,
  useUrlChoice,
  useUrlParams,
  visibleRows,
} from "@/design";
import { enumLabel } from "@/design/vocabulary";
import { formatApiError } from "@/lib/api/error";
import { formatRelativeTime } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import { useRunStanding } from "../hooks";
import { AGENTS_LIST, MASTER_KEY, masterHref, runHref } from "../routes";
import type { MasterStanding, RunStanding, RunStandingList } from "../types";
import { GROUP_MODES, type GroupMode, runGroups } from "../view";
import { MasterPeek, masterRow } from "./master-views";
import { RunPeek, runRow } from "./run-views";

export interface AgentsAccess {
  projectId: string;
  slug: string;
  canWrite: boolean;
}

type Item = RunStanding | MasterStanding;
const isRun = (i: Item): i is RunStanding => "lane" in i;
const keyOf = (i: Item) => (isRun(i) ? i.id : MASTER_KEY);

const FILTERS = ["you", "stuck"] as const;
type Filter = (typeof FILTERS)[number];

const matches = (text: string, r: RunStanding) =>
  !text || [r.id, r.title, r.issue?.key, r.device?.name, r.release?.version, ...r.issues].join(" ").toLowerCase().includes(text);

function Signals({ d }: { d: RunStandingList }) {
  const m = d.master;
  const stuck = d.counts.liveByState.stuck;
  return (
    <SignalsStrip testId="runs-signals">
      <Signal label="Master" testId="signal-master" title="masters/standing.state and pass {verb, startedAt}">
        <StatusBadge family="masterState" value={m.state} />
        {m.pass ? (
          <span className="text-muted">
            {enumLabel("masterVerb", m.pass.verb)}, {formatRelativeTime(m.pass.startedAt)}
          </span>
        ) : null}
      </Signal>
      <Signal label="Slots" testId="signal-slots" title={m.slots?.undeclared?.detail ?? "masters/standing.slots {inUse, max}; max from devices.max_job_panes"}>
        <b className="font-semibold">{m.slots ? m.slots.inUse : "—"}</b>
        {m.slots ? <span className="text-muted">of {m.slots.max ?? "?"}</span> : null}
      </Signal>
      <Signal label="Leases held" testId="signal-held" title="runs/standing counts.held: live runs whose holder is held">
        <b className="font-semibold">{d.counts.held}</b>
      </Signal>
      <Signal label="Stuck" testId="signal-stuck" title="runs/standing counts.liveByState.stuck: core's stuck rule, 3 min of silence">
        <b className={cn("font-semibold", stuck > 0 && "text-danger")}>{stuck}</b>
      </Signal>
    </SignalsStrip>
  );
}

const MODE_OPTIONS = GROUP_MODES.map((m) => ({ value: m, label: m.charAt(0).toUpperCase() + m.slice(1) }));
const SCOPE_LABEL: Record<RunStandingScope, string> = { live: "Live", finished: "Finished", all: "All" };

export function RunsList({ access }: { access: AgentsAccess }) {
  const { projectId, slug, canWrite } = access;
  const router = useRouter();
  const [scope, setScope] = useUrlChoice("scope", RUN_STANDING_SCOPES, "live");
  const [mode, setMode] = useUrlChoice<GroupMode>("group", GROUP_MODES, "attention");
  const [params, setParams] = useUrlParams();
  const text = (params.get("q") ?? "").trim().toLowerCase();
  const on = useMemo(() => new Set((params.get("f") ?? "").split(",").filter((x): x is Filter => (FILTERS as readonly string[]).includes(x))), [params]);
  const toggle = (f: Filter) => {
    const next = new Set(on);
    if (next.has(f)) next.delete(f);
    else next.add(f);
    setParams({ f: next.size ? [...next].join(",") : null });
  };
  const q = useRunStanding(projectId, scope);
  const d = q.data;
  const fold = useGroupFold(`web-v2:runs-fold:${mode}:${scope}`);

  const groups = useMemo((): ListGroup<Item>[] => {
    if (!d) return [];
    const rows = d.items.filter(
      (r) => matches(text, r) && (!on.has("you") || needsViewer(r)) && (!on.has("stuck") || r.state === "stuck"),
    );
    const showMaster = scope !== "finished" && on.size === 0 && !text;
    const master: ListGroup<Item> = { id: MASTER_KEY, ...RUN_MASTER_GROUP, rows: showMaster ? [d.master] : [] };
    const runs = runGroups(rows, mode).map((g) =>
      g.id === "finished" ? { ...g, collapsed: scope === "finished" ? false : RUN_GROUP_LABELS.finished.collapsed } : g,
    );
    return [master, ...(runs as ListGroup<Item>[])];
  }, [d, text, on, scope, mode]);

  const visible = useMemo(() => visibleRows(groups, fold).map(keyOf), [groups, fold]);
  const allKeys = useMemo(() => groups.flatMap((g) => g.rows.map(keyOf)), [groups]);
  const peek = usePeek(visible, allKeys);
  const hrefOf = useCallback((key: string) => (key === MASTER_KEY ? masterHref(slug) : runHref(slug, key)), [slug]);
  const openFull = useCallback(
    (key: string) => {
      rememberListOrigin(AGENTS_LIST);
      router.push(hrefOf(key));
    },
    [router, hrefOf],
  );
  usePeekKeys(peek, openFull);

  if (q.isLoading) {
    return (
      <div className="grid min-h-[50vh] place-items-center">
        <ProjectLoader label="loading runs…" />
      </div>
    );
  }
  if (q.isError || !d) {
    return (
      <div className="grid min-h-[50vh] place-items-center">
        <ErrorState message={formatApiError(q.error)} onRetry={() => q.refetch()} />
      </div>
    );
  }

  const counts: Record<RunStandingScope, number> = { live: d.counts.live, finished: d.counts.finished, all: d.counts.live + d.counts.finished };
  const runRowOf = runRow((id) => runHref(slug, id));
  const masterRowOf = masterRow(masterHref(slug));
  const row = (i: Item) => (isRun(i) ? runRowOf(i) : masterRowOf(i));
  const open = peek.open ? groups.flatMap((g) => g.rows).find((i) => keyOf(i) === peek.open) : undefined;
  const empty = text || on.size ? "No run matches these filters." : scope === "finished" ? "No run on this project has finished yet." : "No live run on this project.";

  return (
    <div className="grid min-h-full content-start bg-app" data-testid="runs-list">
      <Signals d={d} />
      <div className={cn("grid min-h-[60vh] items-start", open && "lg:grid-cols-[minmax(0,1fr)_minmax(380px,440px)]")}>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 border-b border-line-subtle px-5 py-2.5 max-md:px-3" data-testid="runs-toolbar">
            <span className="text-12-5 font-medium text-muted">Group</span>
            <SegmentedControl options={MODE_OPTIONS} value={mode} onChange={setMode} />
            <SegmentedControl
              options={RUN_STANDING_SCOPES.map((s) => ({ value: s, label: SCOPE_LABEL[s], count: counts[s] }))}
              value={scope}
              onChange={setScope}
            />
            <ListSearch noun="runs" value={params.get("q") ?? ""} onChange={(v) => setParams({ q: v || null })} />
            <FilterChip on={on.has("you")} onToggle={() => toggle("you")} count={d.counts.needsViewer} tone="you" testId="filter-you">
              Waiting on you
            </FilterChip>
            <FilterChip on={on.has("stuck")} onToggle={() => toggle("stuck")} count={d.counts.liveByState.stuck} tone="err" testId="filter-stuck">
              <span className="font-mono">is:stuck</span>
            </FilterChip>
            {d.hasMore ? (
              <span className="text-12-5 text-subtle">
                The newest {d.items.length} of {d.total}
              </span>
            ) : null}
          </div>
          <GroupedList
            ariaLabel="Agent runs"
            groups={groups}
            fold={fold}
            row={row}
            selected={peek.open}
            onPeek={(k) => peek.set(k === peek.open ? null : k)}
            empty={empty}
            columns={{ key: "Run", title: "Work", state: "State", waitingOn: "Waiting on", meta: "Holder · age" }}
          />
        </div>
        {open && isRun(open) ? (
          <RunPeek key={open.id} r={open} slug={slug} projectId={projectId} canWrite={canWrite} peek={peek} onOpenFull={() => openFull(open.id)} />
        ) : null}
        {open && !isRun(open) ? <MasterPeek m={open} peek={peek} onOpenFull={() => openFull(MASTER_KEY)} /> : null}
      </div>
    </div>
  );
}
