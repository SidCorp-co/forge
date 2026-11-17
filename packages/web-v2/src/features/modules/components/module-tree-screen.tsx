// A module's page on the map (ISS-1256, mockup MK-11): its tree on the left (terms, rules,
// capabilities, requirements, decisions, references, in flight) and, on the right, the rail of the
// node it selects. A pillar count lands here at its branch (`?type=`), a find hit at its node
// (`?node=`). Its Capabilities view lists the doors the tree places in this module. The Unplaced page
// lists, in the same branches, what no module holds.

import { FIND_UNPLACED_FILTER } from "@forge/contracts/find";
import type { ModuleTreeResponse } from "@forge/contracts/module-map";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { DetailHeader, Icon, SegmentedControl, useMediaQuery, useUrlChoice, useUrlParams } from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy } from "@/lib/i18n/interface-language";
import { Link } from "@/lib/navigation/router";
import { modulesHref } from "@/lib/routes/modules";
import { cn } from "@/lib/utils/cn";
import { useModuleTree, usePillar } from "../hooks";
import { branchesOf, selectedOf, type TreeBranchView, type TreeNodeView, treeNamesOf, unplacedBranchesOf } from "../module-tree";
import { moduleNamesOf, TREE_BRANCHES, type TreeBranch } from "../pillar";
import { CapabilitiesBranch } from "./capabilities-branch";
import { MapSearch } from "./module-map-screen";
import { NodeRail } from "./node-rail";
import { branchLabel } from "./pillar-table";

const PAGE_VIEWS = ["tree", "capabilities"] as const;
type PageView = (typeof PAGE_VIEWS)[number];

const atOf = (v: string | null): TreeBranch | null => ((TREE_BRANCHES as readonly string[]).includes(v ?? "") ? (v as TreeBranch) : null);

function TreeEntry({ n, selected, onSelect }: { n: TreeNodeView; selected: boolean; onSelect: (id: string) => void }) {
  const t = useCopy();
  const body = (
    <>
      <span className={cn("min-w-0", selected && "font-semibold")}>{n.title}</span>
      {/* the picked node's other names are the rail's, said once */}
      {n.meta && !selected ? (
        <span className="min-w-0 truncate text-12-5 text-muted" title={n.meta}>
          {n.meta}
        </span>
      ) : null}
      {n.retiring ? <span className="rounded-sm bg-sunken px-1 text-11 font-semibold uppercase text-warn-11">{t("modules.rail.retiring")}</span> : null}
    </>
  );
  const row = "flex w-full min-w-0 flex-wrap items-baseline gap-x-2.5 rounded-sm px-1.5 py-1 text-left text-14";
  if (n.node)
    return (
      <button type="button" aria-current={selected || undefined} onClick={() => onSelect(n.id)} title={n.summary ?? undefined} className={cn(row, selected ? "bg-accent-tint" : "hover:bg-hover")} data-testid="tree-node" data-node={n.id}>
        {body}
      </button>
    );
  if (n.href)
    return (
      <Link href={n.href} className={cn(row, "hover:bg-hover")} data-testid="tree-node" data-node={n.id}>
        {body}
      </Link>
    );
  return (
    <span className={row} data-testid="tree-node" data-node={n.id}>
      {body}
    </span>
  );
}

/** The branches drawn open on arrival: the one a count named, the selected node's, else the first that holds anything. */
function openOnArrival(branches: readonly TreeBranchView[], at: TreeBranch | null, selected: string | null): Set<TreeBranch> {
  const held = branches.find((b) => b.nodes.some((n) => n.id === selected))?.branch;
  const first = branches.find((b) => b.nodes.length > 0)?.branch;
  return new Set([at ?? held ?? first].filter((b): b is TreeBranch => Boolean(b)));
}

function Tree({
  branches,
  at,
  selected,
  onSelect,
  detail,
}: {
  branches: readonly TreeBranchView[];
  at: TreeBranch | null;
  selected: string | null;
  onSelect: (id: string) => void;
  /** The selected node's rail, drawn under it: below 1024px, where no column stands beside the tree. */
  detail?: ReactNode;
}) {
  const t = useCopy();
  // every branch reads its name and count; its items open on demand, so the page leads with the map's shape
  const [opened, setOpened] = useState(() => openOnArrival(branches, at, selected));
  const held = branches.find((b) => b.nodes.some((n) => n.id === selected))?.branch;
  const isOpen = (b: TreeBranch) => opened.has(b) || b === held;
  const toggle = (b: TreeBranch) =>
    setOpened((cur) => {
      const next = new Set(cur);
      if (!next.delete(b)) next.add(b);
      return next;
    });
  // a count opened the tree at its branch: that branch is brought into view once, on arrival
  useEffect(() => {
    if (at) document.getElementById(`branch-${at}`)?.scrollIntoView?.({ block: "start" });
  }, [at]);
  return (
    // every grid here sizes its one column to the page, never to its widest line: a term's other names
    // run on one line, truncated, and an auto column would widen to hold them, past a phone's edge
    <ul className="grid grid-cols-1 gap-1" aria-label={t("modules.tree.label")} data-testid="module-tree">
      {branches.map((b) => (
        <li key={b.branch} id={`branch-${b.branch}`} className="scroll-mt-4" data-testid={`tree-branch-${b.branch}`} data-at={b.branch === at || undefined} data-open={isOpen(b.branch) || undefined}>
          <button
            type="button"
            aria-expanded={isOpen(b.branch)}
            onClick={() => toggle(b.branch)}
            className={cn("flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left font-semibold hover:bg-hover", b.branch === at && "bg-sunken")}
            data-testid="tree-branch-toggle"
          >
            <Icon name={isOpen(b.branch) ? "chevronDown" : "chevronRight"} size={14} className="flex-none text-subtle" />
            {branchLabel(t, b.branch)} <span className="text-12 font-normal tabular-nums text-subtle">{b.count}</span>
          </button>
          {isOpen(b.branch) ? (
            <ul className="ml-5 grid grid-cols-1 gap-0.5 border-l border-line-subtle pl-3">
              {b.nodes.map((n) => (
                <li key={n.id}>
                  <TreeEntry n={n} selected={n.id === selected} onSelect={onSelect} />
                  {detail && n.id === selected ? (
                    <div id="node-detail" className="my-2 scroll-mt-4 rounded-sm border border-line-subtle bg-surface px-3 py-3" data-testid="module-rail-inline">
                      {detail}
                    </div>
                  ) : null}
                </li>
              ))}
              {b.nodes.length === 0 ? <li className="px-1.5 py-1 text-13 text-subtle">{t("modules.tree.none")}</li> : null}
              {b.count > b.nodes.length && b.nodes.length > 0 ? <li className="px-1.5 py-1 text-13 text-subtle">{t("modules.tree.more", { n: b.count - b.nodes.length })}</li> : null}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function useSelection() {
  const [params, set] = useUrlParams();
  const at = atOf(params.get("type"));
  const node = params.get("node");
  return { at, node, select: (id: string) => set({ node: id }) };
}

function TreePage({ slug, tree, names }: { slug: string; tree: ModuleTreeResponse; names: ReadonlyMap<string, string> }) {
  const t = useCopy();
  const { at, node, select } = useSelection();
  const wide = useMediaQuery("(min-width: 1024px)");
  const branches = useMemo(() => branchesOf(slug, tree), [slug, tree]);
  const here = useMemo(() => new Set(branches.flatMap((b) => b.nodes.filter((n) => n.node).map((n) => n.id))), [branches]);
  const { chosen, missing } = selectedOf(branches, at, node);
  // a pick (a tap on the tree or a relation in the rail) is followed to the node it selects, its
  // rail drawn under it below 1024px; an arrival keeps the place a count or link opened
  const pickedRef = useRef(false);
  useEffect(() => {
    if (!pickedRef.current || !chosen) return;
    pickedRef.current = false;
    document.querySelector(`[data-node="${CSS.escape(chosen.id)}"]`)?.scrollIntoView?.({ block: "start" });
  }, [chosen]);
  const onSelect = (id: string) => {
    pickedRef.current = true;
    select(id);
  };
  const rail = chosen?.node ? <NodeRail node={chosen.node} slug={slug} here={here} names={names} readsDays={tree.readsWindowDays} onSelect={onSelect} under={!wide} /> : null;
  const code = tree.module.children.map((c) => c.name).join(", ");
  return (
    <div className="lg:flex" data-testid="module-tree-page">
      <div className="grid min-w-0 flex-1 grid-cols-1 content-start gap-4 bg-app px-5 py-5 max-md:px-3">
        {tree.module.description || code ? (
          <div className="grid gap-1 text-13 text-muted">
            {tree.module.description ? (
              <p className="line-clamp-2 max-w-3xl" title={tree.module.description}>
                {tree.module.description}
              </p>
            ) : null}
            {code ? (
              <p>
                <span className="font-medium text-fg">{t("modules.tree.code")}</span> {code}
              </p>
            ) : null}
          </div>
        ) : null}
        {/* an address naming a node this tree does not hold says so, rather than showing another in its place */}
        {missing ? (
          <p role="status" className="rounded-sm border border-line-subtle bg-surface px-3 py-2 text-13 text-muted" data-testid="tree-node-missing">
            {t("modules.tree.missing")}
          </p>
        ) : null}
        <Tree branches={branches} at={at} selected={chosen?.id ?? null} onSelect={onSelect} detail={wide ? undefined : rail} />
      </div>
      {wide ? (
        <aside className="min-w-0 w-88 flex-none border-l border-line-subtle bg-surface px-5 py-5" aria-label={t("modules.rail.relations")} data-testid="module-rail">
          <div className="sticky top-4">{rail ?? <p className="text-13 text-subtle">{t("modules.rail.pick")}</p>}</div>
        </aside>
      ) : null}
    </div>
  );
}

function ViewBar({ view, onView }: { view: PageView | null; onView?: (v: PageView) => void }) {
  const t = useCopy();
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-line-subtle bg-surface px-5 py-2.5 max-md:px-3" aria-label={t("modules.views")}>
      {view && onView ? <SegmentedControl options={PAGE_VIEWS.map((v) => ({ value: v, label: t(`modules.view.${v}`) }))} value={view} onChange={onView} /> : null}
      <MapSearch />
    </div>
  );
}

function UnplacedScreen({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useCopy();
  const q = usePillar(projectId);
  const { at } = useSelection();
  return (
    <div className="min-h-full bg-app" data-testid="module-screen">
      <DetailHeader back={{ href: modulesHref(slug), label: t("modules.title") }} title={t("modules.unplaced")} keepTitle />
      <ViewBar view={null} />
      <QueryBoundary query={q} loadingLabel={t("modules.loadingOne")}>
        {(read) => (
          <div className="px-5 py-5 max-md:px-3">
            <Tree branches={unplacedBranchesOf(slug, read)} at={at} selected={null} onSelect={() => {}} />
          </div>
        )}
      </QueryBoundary>
    </div>
  );
}

function ModuleScreen({ projectId, slug, moduleSlug }: { projectId: string; slug: string; moduleSlug: string }) {
  const t = useCopy();
  const q = useModuleTree(projectId, moduleSlug);
  const pillar = usePillar(projectId).data;
  const [view, setView] = useUrlChoice<PageView>("view", PAGE_VIEWS, "tree");
  const tree = q.data;
  const names = useMemo(() => (tree ? treeNamesOf(tree, moduleNamesOf(pillar)) : new Map<string, string>()), [tree, pillar]);
  const doors = useMemo(() => new Set(tree?.branches.capability.map((c) => c.ref) ?? []), [tree]);
  return (
    <div className="min-h-full bg-app" data-testid="module-screen">
      {/* the module's name stays in the bar on a phone too: the tree is long, and a column title scrolls away */}
      <DetailHeader back={{ href: modulesHref(slug), label: t("modules.title") }} title={tree?.module.name ?? names.get(moduleSlug) ?? t("modules.loadingOne")} keepTitle />
      <ViewBar view={view} onView={setView} />
      <QueryBoundary query={q} loadingLabel={t("modules.loadingOne")}>
        {(read) => (view === "capabilities" ? <CapabilitiesBranch projectId={projectId} only={doors} /> : <TreePage slug={slug} tree={read} names={names} />)}
      </QueryBoundary>
    </div>
  );
}

export function ModuleTreeScreen({ projectId, slug, moduleSlug }: { projectId: string; slug: string; moduleSlug: string }) {
  return moduleSlug === FIND_UNPLACED_FILTER ? <UnplacedScreen projectId={projectId} slug={slug} /> : <ModuleScreen projectId={projectId} slug={slug} moduleSlug={moduleSlug} />;
}
