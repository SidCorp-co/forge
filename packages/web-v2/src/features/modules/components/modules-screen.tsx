"use client";
import { MODULE_ATTENTION_GROUPS, MODULE_ATTENTION_LABELS, } from "@forge/contracts/modules";
import { useRouter } from "next/navigation";
import { useCallback, useMemo } from "react";
import {
  EmptyState,
  ErrorState,
  GroupedList,
  type ListGroup,
  ListSearch,
  type ListRowView,
  PageTitle,
  ProjectLoader,
  rememberListOrigin,
  useGroupFold,
  usePeek,
  usePeekKeys,
  useUrlParams,
  useViewMode,
  ViewModeSwitcher,
  visibleRows,
  WaitingOn,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { formatAge, formatStamp } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import { useModuleRollup } from "../hooks";
import { MODULES_LIST, moduleHref } from "../routes";
import type { ModuleRollupRow } from "../types";
import { moduleWaitingView, OpenBar } from "./module-bits";
import { ModulePeek } from "./module-peek";

const GROUP_MODES = [
  { value: "attention" as const, label: "Attention", title: "Grouped by whose turn it is" },
  { value: "tree" as const, label: "Tree", title: "Grouped under each root module" },
];
type GroupMode = (typeof GROUP_MODES)[number]["value"];

const COLUMNS = { key: "Module", title: "Name", state: "Open issues", meta: "Last landing" } as const;

function groupsOf(rows: ModuleRollupRow[], mode: GroupMode): ListGroup<ModuleRollupRow>[] {
  if (mode === "attention") {
    return MODULE_ATTENTION_GROUPS.map((g) => ({
      id: g,
      label: MODULE_ATTENTION_LABELS[g].label,
      tone: MODULE_ATTENTION_LABELS[g].tone,
      collapsed: MODULE_ATTENTION_LABELS[g].collapsed,
      rows: rows.filter((r) => r.standing.attentionGroup === g),
    }));
  }
  const roots = rows.filter((r) => r.depth === 0);
  const ownerOf = (r: ModuleRollupRow) => {
    const root = r.path.split("/")[0];
    return roots.find((x) => x.path === root)?.id ?? r.id;
  };
  const byRoot = new Map<string, ModuleRollupRow[]>();
  for (const r of rows) byRoot.set(ownerOf(r), [...(byRoot.get(ownerOf(r)) ?? []), r]);
  return [...byRoot].map(([rootId, members]) => {
    const root = rows.find((r) => r.id === rootId);
    return {
      id: `tree:${rootId}`,
      label: root?.path ?? members[0]?.path ?? "",
      mono: true,
      tone: null,
      summary: MODULE_ATTENTION_GROUPS.filter((g) => g !== "quiet")
        .map((g) => ({ label: MODULE_ATTENTION_LABELS[g].label, count: members.filter((m) => m.standing.attentionGroup === g).length, tone: MODULE_ATTENTION_LABELS[g].tone }))
        .filter((s) => s.count > 0),
      rows: members,
    };
  });
}

function keyLabel(r: ModuleRollupRow, indent: boolean) {
  const cut = r.path.lastIndexOf("/");
  return (
    <span className="whitespace-normal break-words" style={indent ? { paddingLeft: r.depth * 10 } : undefined}>
      {cut >= 0 ? <span className="text-subtle">{r.path.slice(0, cut + 1)}</span> : null}
      <wbr />
      {r.path.slice(cut + 1)}
    </span>
  );
}

function factsLine(r: ModuleRollupRow): string[] {
  const s = r.standing;
  const parts = [`Open ${s.open}`];
  if (s.running > 0) parts.push(`Running ${s.running}`);
  const stuck = s.openByKind.stuck;
  if (stuck > 0) parts.push(`Stuck ${stuck}`);
  if (s.childCount > 0) parts.push(`Children ${s.childCount}`);
  if (r.description) parts.push(r.description);
  return parts;
}

const rowOf =
  (slug: string) =>
  (r: ModuleRollupRow, max: number, indent: boolean): ListRowView => {
    const land = r.standing.lastLanding;
    return {
      key: r.slug ?? r.id,
      keyLabel: keyLabel(r, indent),
      href: moduleHref(slug, r.slug ?? r.id),
      title: r.name,
      facts: factsLine(r),
      state: <OpenBar standing={r.standing} max={max} />,
      waitingOn: <WaitingOn w={moduleWaitingView(r.standing)} />,
      owner: land ? <span className="font-mono text-11-5">{land.issueKey}</span> : <span className="text-subtle">None yet</span>,
      age: land ? { text: formatAge(land.landedAt), title: `Landed ${formatStamp(land.landedAt)}` } : null,
      dim: r.standing.attentionGroup === "quiet",
    };
  };

export function ModulesScreen({ projectId, slug }: { projectId: string; slug: string }) {
  const q = useModuleRollup(projectId);
  const router = useRouter();
  const [params, setParams] = useUrlParams();
  const [mode, setMode] = useViewMode(GROUP_MODES);
  const text = params.get("q") ?? "";
  const fold = useGroupFold("web-v2:modules-fold");

  const all = q.data?.modules ?? [];
  const max = useMemo(() => Math.max(1, ...all.map((r) => r.standing.open)), [all]);
  const rows = useMemo(() => {
    const t = text.trim().toLowerCase();
    return t ? all.filter((r) => `${r.path} ${r.name} ${r.description ?? ""}`.toLowerCase().includes(t)) : all;
  }, [all, text]);
  const groups = useMemo(() => groupsOf(rows, mode), [rows, mode]);
  const visible = useMemo(() => visibleRows(groups, fold).map((r) => r.slug ?? r.id), [groups, fold]);
  const allKeys = useMemo(() => all.map((r) => r.slug ?? r.id), [all]);
  const peek = usePeek(visible, allKeys);
  const toRow = useMemo(() => rowOf(slug), [slug]);
  const row = useCallback((r: ModuleRollupRow) => toRow(r, max, mode === "tree"), [toRow, max, mode]);

  const openFull = useCallback(
    (key: string) => {
      rememberListOrigin(MODULES_LIST);
      router.push(moduleHref(slug, key));
    },
    [router, slug],
  );
  usePeekKeys(peek, openFull);

  const title = <PageTitle after={<ViewModeSwitcher modes={GROUP_MODES} value={mode} onChange={setMode} placement="header" />}>Modules</PageTitle>;

  if (q.isLoading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        {title}
        <ProjectLoader label="loading modules…" />
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
  const read = q.data.issuesRead;
  const unread = read.open - read.returned;

  return (
    <div className="grid min-h-full content-start bg-app" data-testid="modules-screen">
      {title}
      <div className={cn("grid min-h-[60vh] items-start", peek.open && "lg:grid-cols-[minmax(0,1fr)_minmax(380px,440px)]")}>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 border-b border-line-subtle px-5 py-2.5 max-md:px-3">
            <ViewModeSwitcher modes={GROUP_MODES} value={mode} onChange={setMode} placement="toolbar" />
            <ListSearch noun="modules" value={text} onChange={(v) => setParams({ q: v || null })} />
            <span className="ml-auto text-12 text-subtle" title="Open issues in no module are not counted in any row">
              Open issues in no module {q.data.unassigned.open}
            </span>
          </div>
          {unread > 0 ? (
            <p className="border-b border-line-subtle px-5 py-2 text-12-5 text-muted" data-testid="modules-truncated">
              The counts read the {read.returned} most recently written of {read.open} open issues; {unread} older ones are not in them.
            </p>
          ) : null}
          {all.length === 0 ? (
            <div className="px-5 py-10">
              <EmptyState title="No module has been declared" message="A module is a label of kind module. Issues are attributed to one, and it appears here with what is open and what landed." />
            </div>
          ) : (
            <GroupedList
              ariaLabel="Modules"
              groups={groups}
              fold={fold}
              row={row}
              selected={peek.open}
              onPeek={(k) => peek.set(k === peek.open ? null : k)}
              empty="Nothing matches this search."
              columns={COLUMNS}
            />
          )}
        </div>
        {peek.open ? (
          <ModulePeek key={peek.open} projectId={projectId} slug={slug} moduleSlug={peek.open} peek={peek} onOpenFull={() => openFull(peek.open as string)} />
        ) : null}
      </div>
    </div>
  );
}
