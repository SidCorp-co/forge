"use client";

// Agents / Runs (ISS-111, prototype #/dev/runs, design agent-run-standing rev 1): the signals line,
// the project master row and every run grouped by core's attentionGroup (or by lane or box), a peek and a
// full page per row, all read from GET /runs/standing; the band and the list read the same answer, so
// they can never disagree about how many runs there are
import { RUN_GROUP_LABELS, RUN_MASTER_GROUP, RUN_STANDING_SCOPES, type RunStandingScope } from "@forge/contracts/run-standing";
import { needsViewer } from "@forge/contracts/standing";
import {
  FilterChip,
  GroupedList,
  type ListGroup,
  ListLayout,
  ListSearch,
  ListToolbar,
  SegmentedControl,
  Signal,
  SignalsStrip,
  StatusBadge,
  useListPage,
  useUrlChoice,
} from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { enumLabel } from "@/design/vocabulary";
import { formatRelative } from "@/lib/i18n/format";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import { said } from "@/lib/i18n/said";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { cn } from "@/lib/utils/cn";
import { useRunStanding } from "../hooks";
import { AGENTS_LIST, MASTER_KEY, masterHref, runHref } from "@/lib/routes/agents";
import type { MasterStanding, RunStanding, RunStandingList } from "../types";
import { attentionGroupText, GROUP_MODES, type GroupMode, runGroups } from "../view";
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

function Signals({ d }: { d: RunStandingList }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const time = useTimeFormat();
  const m = d.master;
  const stuck = d.counts.liveByState.stuck;
  return (
    <SignalsStrip testId="runs-signals">
      <Signal label={t("agents.master.word")} testId="signal-master" title={t("agents.signal.masterTitle")}>
        <StatusBadge family="masterState" value={m.state} />
        {m.pass ? (
          <span className="text-muted">
            {enumLabel("masterVerb", m.pass.verb, language)}, {formatRelative(m.pass.startedAt, language)}
          </span>
        ) : null}
      </Signal>
      <Signal label={t("agents.signal.slots")} testId="signal-slots" title={m.slots?.undeclared ? said(m.slots.undeclared.says.detail, language) : t("agents.signal.slotsTitle")}>
        <b className="font-semibold">{m.slots ? time.number(m.slots.inUse) : "—"}</b>
        {m.slots ? <span className="text-muted">{t("agents.signal.of", { max: m.slots.max ?? "?" })}</span> : null}
        {m.slots && m.slots.runs > 0 ? <span className="text-muted">· {t(m.slots.runs === 1 ? "agents.signal.declaredOne" : "agents.signal.declaredMany", { n: time.number(m.slots.runs) })}</span> : null}
      </Signal>
      <Signal label={t("agents.signal.held")} testId="signal-held" title={t("agents.signal.heldTitle")}>
        <b className="font-semibold">{time.number(d.counts.held)}</b>
      </Signal>
      <Signal label={t("agents.signal.stuck")} testId="signal-stuck" title={t("agents.signal.stuckTitle")}>
        <b className={cn("font-semibold", stuck > 0 && "text-danger")}>{time.number(stuck)}</b>
      </Signal>
    </SignalsStrip>
  );
}

const MODE_KEY: Record<GroupMode, ProductCopyKey> = { attention: "agents.mode.attention", lane: "agents.mode.lane", box: "agents.mode.box" };
const SCOPE_KEY: Record<RunStandingScope, ProductCopyKey> = { live: "agents.scope.live", finished: "agents.scope.finished", all: "agents.scope.all" };

export function RunsList({ access }: { access: AgentsAccess }) {
  const { projectId, slug, canWrite } = access;
  const t = useCopy();
  const language = useInterfaceLanguage();
  const time = useTimeFormat();
  const [scope, setScope] = useUrlChoice("scope", RUN_STANDING_SCOPES, "live");
  const [mode, setMode] = useUrlChoice<GroupMode>("group", GROUP_MODES, "attention");
  const q = useRunStanding(projectId, scope);
  const d = q.data;
  const filtersOf = (params: URLSearchParams) => new Set((params.get("f") ?? "").split(",").filter((x): x is Filter => (FILTERS as readonly string[]).includes(x)));
  const list = useListPage<Item>({
    rows: d ? [d.master, ...d.items] : [],
    keyOf,
    searchOf: (i) => (isRun(i) ? [i.id, i.boxRunId, i.title, i.issue?.key, i.device?.name, i.release?.version, ...i.issues].join(" ") : ""),
    narrow: (i, params) => {
      const on = filtersOf(params);
      if (!isRun(i)) return scope !== "finished" && on.size === 0;
      return (!on.has("you") || needsViewer(i)) && (!on.has("stuck") || i.state === "stuck");
    },
    groupsOf: (rows) => {
      const runs = runGroups(rows.filter(isRun), mode, language).map((g) =>
        g.id === "finished" ? { ...g, collapsed: scope === "finished" ? false : RUN_GROUP_LABELS.finished.collapsed } : g,
      );
      const master: ListGroup<Item> = { id: MASTER_KEY, ...RUN_MASTER_GROUP, ...attentionGroupText("master", language), rows: rows.filter((i) => !isRun(i)) };
      return [master, ...(runs as ListGroup<Item>[])];
    },
    foldKey: `web-v2:runs-fold:${mode}:${scope}`,
    hrefOf: (key) => (key === MASTER_KEY ? masterHref(slug) : runHref(slug, key)),
    origin: AGENTS_LIST,
  });
  const { peek, params, setParams } = list;
  const on = filtersOf(params);
  const toggle = (f: Filter) => {
    const next = new Set(on);
    if (!next.delete(f)) next.add(f);
    setParams({ f: next.size ? [...next].join(",") : null });
  };
  return (
    <QueryBoundary query={q} loadingLabel={t("agents.loadingRuns")} height="50vh" retry="always">
      {(d) => {
        const counts: Record<RunStandingScope, number> = { live: d.counts.live, finished: d.counts.finished, all: d.counts.live + d.counts.finished };
        const runRowOf = runRow((id) => runHref(slug, id), t, language);
        const masterRowOf = masterRow(masterHref(slug), t, language);
        const open = peek.open ? list.rows.find((i) => keyOf(i) === peek.open) : undefined;
        const empty = list.search.value || on.size ? t("agents.empty.filters") : scope === "finished" ? t("agents.empty.finished") : t("agents.empty.live");
        return (
          <div className="grid min-h-full content-start bg-app" data-testid="runs-list">
            <Signals d={d} />
            <ListLayout
              peek={
                open ? (
                  isRun(open) ? (
                    <RunPeek key={open.id} r={open} slug={slug} canWrite={canWrite} peek={peek} onOpenFull={() => list.openFull(open.id)} />
                  ) : (
                    <MasterPeek m={open} peek={peek} onOpenFull={() => list.openFull(MASTER_KEY)} />
                  )
                ) : undefined
              }
            >
              <ListToolbar testId="runs-toolbar">
                <span className="text-13 font-medium text-muted">{t("agents.group")}</span>
                <SegmentedControl options={GROUP_MODES.map((m) => ({ value: m, label: t(MODE_KEY[m]) }))} value={mode} onChange={setMode} />
                <SegmentedControl options={RUN_STANDING_SCOPES.map((s) => ({ value: s, label: t(SCOPE_KEY[s]), count: counts[s] }))} value={scope} onChange={setScope} />
                <ListSearch noun={t("agents.runsNoun")} {...list.search} />
                <FilterChip on={on.has("you")} onToggle={() => toggle("you")} count={d.counts.needsViewer} tone="you" testId="filter-you">
                  {t("agents.filter.you")}
                </FilterChip>
                <FilterChip on={on.has("stuck")} onToggle={() => toggle("stuck")} count={d.counts.liveByState.stuck} tone="err" testId="filter-stuck">
                  <span className="font-mono" translate="no">is:stuck</span>
                </FilterChip>
                {d.hasMore ? <span className="text-13 text-subtle">{t("agents.newestOf", { n: time.number(d.items.length), total: time.number(d.total) })}</span> : null}
              </ListToolbar>
              <GroupedList
                ariaLabel={t("agents.listLabel")}
                groups={list.groups}
                fold={list.fold}
                row={(i: Item) => (isRun(i) ? runRowOf(i) : masterRowOf(i))}
                selected={peek.open}
                onPeek={list.togglePeek}
                empty={empty}
                columns={{ key: t("agents.col.run"), title: t("agents.col.work"), state: t("agents.col.state"), waitingOn: t("agents.col.waitingOn"), meta: t("agents.col.meta") }}
              />
            </ListLayout>
          </div>
        );
      }}
    </QueryBoundary>
  );
}
