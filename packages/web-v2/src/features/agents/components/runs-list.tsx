// Agents / Runs (ISS-111, design agent-run-standing rev 1; face ISS-903): the project master and every
// run grouped by core's attentionGroup (or by lane or box), all read from GET /runs/standing. The face is
// a group's label and count, then one line per run: its title and its state, whom it waits on that
// state's hover. A run opens in place (j/k, Enter) on its path, its banner, its acts and its facts, with
// its full page a link; the grouping and the filters are the palette's (⌘K), and the screen's one next
// action is the run that needs the viewer, else the first one stuck.
import { RUN_GROUP_LABELS, RUN_MASTER_GROUP, RUN_STANDING_SCOPES, type RunStandingScope } from "@forge/contracts/run-standing";
import { needsViewer } from "@forge/contracts/standing";
import {
  type Command,
  CountSection,
  ExpandRow,
  ExpandRows,
  type ListGroup,
  ListSearch,
  ListToolbar,
  NextAction,
  SegmentedControl,
  useListPage,
  usePageCommands,
  useUrlChoice,
  useUrlFlags,
} from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { saidView } from "@/lib/i18n/said";
import { issueHref } from "@/lib/routes/issues";
import { useRunStanding } from "../hooks";
import { AGENTS_LIST, MASTER_KEY, masterHref, runHref } from "@/lib/routes/agents";
import type { MasterStanding, RunStanding, RunStandingList } from "../types";
import { attentionGroupText, GROUP_MODES, type GroupMode, runGroups } from "../view";
import { MasterDetail, MasterLine } from "./master-views";
import { RunDetail, RunLine } from "./run-views";

export interface AgentsAccess {
  projectId: string;
  slug: string;
  canWrite: boolean;
}

type Item = RunStanding | MasterStanding;
const isRun = (i: Item): i is RunStanding => "lane" in i;
const keyOf = (i: Item) => (isRun(i) ? i.id : MASTER_KEY);

const FILTERS = ["you", "stuck"] as const;

const MODE_KEY: Record<GroupMode, ProductCopyKey> = { attention: "agents.mode.attention", lane: "agents.mode.lane", box: "agents.mode.box" };
const SCOPE_KEY: Record<RunStandingScope, ProductCopyKey> = { live: "agents.scope.live", finished: "agents.scope.finished", all: "agents.scope.all" };

/** What the list search reads on a run: core's id and the id its box declared it under (a refusal names that one, FB-122), its title, issue, box and release. */
export const runSearchText = (r: RunStanding) => [r.id, r.boxRunId, r.title, r.issue?.key, r.device?.name, r.release?.version, ...r.issues].join(" ");

/** The one act the screen leads with: the run waiting on the viewer (its answer is on its issue), else the first run stuck. */
function NextRun({ d, slug }: { d: RunStandingList; slug: string }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const yours = d.items.find((r) => needsViewer(r) && r.waitingOn.kind === "you");
  if (yours) {
    const act = yours.waitingOn.kind === "you" ? saidView(yours.waitingOn, language).act : "";
    const label = act ? `${act.charAt(0).toUpperCase()}${act.slice(1)}` : t("agents.next.answer");
    return <NextAction label={label} href={yours.issue ? issueHref(slug, yours.issue.key) : runHref(slug, yours.id)} testId="runs-next" />;
  }
  const stuck = d.items.find((r) => r.state === "stuck");
  return stuck ? <NextAction label={t("agents.next.stuck")} href={runHref(slug, stuck.id)} testId="runs-next" /> : <NextAction label={t("agents.next.stuck")} />;
}

/** The grouping and the two filters, as the palette's acts for this page. */
function useRunsCommands(mode: GroupMode, setMode: (m: GroupMode) => void, on: Set<string>, toggle: (f: (typeof FILTERS)[number]) => void) {
  const t = useCopy();
  const commands: Command[] = [
    ...GROUP_MODES.filter((m) => m !== mode).map((m): Command => ({ label: t("agents.cmd.group", { mode: t(MODE_KEY[m]) }), icon: "list", onRun: () => setMode(m) })),
    { label: t("agents.cmd.onlyYou"), icon: "filter", onRun: () => toggle("you") },
    { label: t("agents.cmd.onlyStuck"), icon: "filter", onRun: () => toggle("stuck") },
    ...(on.size > 0 ? [{ label: t("agents.cmd.everyRun"), icon: "x" as const, onRun: () => [...on].forEach((f) => toggle(f as (typeof FILTERS)[number])) }] : []),
  ];
  usePageCommands(commands);
}

export function RunsList({ access }: { access: AgentsAccess }) {
  const { projectId, slug, canWrite } = access;
  const t = useCopy();
  const language = useInterfaceLanguage();
  const time = useTimeFormat();
  const [scope, setScope] = useUrlChoice("scope", RUN_STANDING_SCOPES, "live");
  const [mode, setMode] = useUrlChoice<GroupMode>("group", GROUP_MODES, "attention");
  const q = useRunStanding(projectId, scope);
  const d = q.data;
  const [on, toggle] = useUrlFlags(FILTERS);
  useRunsCommands(mode, setMode, on, toggle);
  const list = useListPage<Item>({
    rows: d ? [d.master, ...d.items] : [],
    keyOf,
    searchOf: (i) => (isRun(i) ? runSearchText(i) : ""),
    narrow: (i) => {
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
  return (
    <QueryBoundary query={q} loadingLabel={t("agents.loadingRuns")} height="50vh" retry="always">
      {(d) => {
        const counts: Record<RunStandingScope, number> = { live: d.counts.live, finished: d.counts.finished, all: d.counts.live + d.counts.finished };
        const groups = list.groups.filter((g) => g.rows.length > 0);
        const empty = list.search.value || on.size ? t("agents.empty.filters") : scope === "finished" ? t("agents.empty.finished") : t("agents.empty.live");
        return (
          <div className="grid min-h-full content-start bg-app" data-testid="runs-list">
            <NextRun d={d} slug={slug} />
            <ListToolbar testId="runs-toolbar">
              <SegmentedControl options={RUN_STANDING_SCOPES.map((s) => ({ value: s, label: t(SCOPE_KEY[s]), count: counts[s] }))} value={scope} onChange={setScope} />
              <ListSearch noun={t("agents.runsNoun")} {...list.search} />
              {d.hasMore ? <span className="text-13 text-subtle">{t("agents.newestOf", { n: time.number(d.items.length), total: time.number(d.total) })}</span> : null}
            </ListToolbar>
            {groups.length === 0 || groups.every((g) => g.id === MASTER_KEY) ? <p className="px-5 py-6 text-13 text-muted" data-testid="runs-empty">{empty}</p> : null}
            <div className="px-5" aria-label={t("agents.listLabel")}>
              {groups.map((g) => (
                <CountSection key={g.id} label={typeof g.label === "string" ? g.label : g.id} count={g.rows.length} defaultOpen={!g.collapsed} testId={`runs-group-${g.id}`}>
                  <ExpandRows label={typeof g.label === "string" ? g.label : g.id} className="-ml-7">
                    {g.rows.map((i) =>
                      isRun(i) ? (
                        <ExpandRow key={i.id} id={i.id} head={<RunLine r={i} />} testId="run-row">
                          <RunDetail r={i} slug={slug} canWrite={canWrite} href={runHref(slug, i.id)} />
                        </ExpandRow>
                      ) : (
                        <ExpandRow key={MASTER_KEY} id={MASTER_KEY} head={<MasterLine m={i} />} testId="master-row">
                          <MasterDetail m={i} href={masterHref(slug)} />
                        </ExpandRow>
                      ),
                    )}
                  </ExpandRows>
                </CountSection>
              ))}
            </div>
          </div>
        );
      }}
    </QueryBoundary>
  );
}
