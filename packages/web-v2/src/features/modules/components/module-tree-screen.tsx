// A module's page on the map (ISS-1256, mockup MK-11): its tree on the left (terms, rules,
// capabilities, requirements, decisions, references, in flight) and, on the right, the rail of the
// node it selects. A pillar count lands here at its branch (`?type=`), a find hit at its node
// (`?node=`). Its Capabilities view lists the doors the tree places in this module. The Unplaced page
// lists, in the same branches, what no module holds.

import { FIND_UNPLACED_FILTER } from "@forge/contracts/find";
import type { ModuleTreeResponse } from "@forge/contracts/module-map";
import { useEffect, useMemo, useRef } from "react";
import { DetailHeader, DetailMobileTitle, SegmentedControl, useMediaQuery, useUrlChoice, useUrlParams } from "@/design";
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
      {n.meta ? <span className="min-w-0 truncate text-12-5 text-muted">{n.meta}</span> : null}
      {n.retiring ? <span className="rounded-sm bg-sunken px-1 text-11 font-semibold uppercase text-warn-11">{t("modules.rail.retiring")}</span> : null}
    </>
  );
  const row = "flex w-full min-w-0 flex-wrap items-baseline gap-x-2.5 rounded-sm px-1.5 py-1 text-left text-14";
  if (n.node)
    return (
      <button type="button" aria-current={selected || undefined} onClick={() => onSelect(n.id)} className={cn(row, selected ? "bg-accent-tint" : "hover:bg-hover")} data-testid="tree-node" data-node={n.id}>
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

function Tree({ branches, at, selected, onSelect }: { branches: readonly TreeBranchView[]; at: TreeBranch | null; selected: string | null; onSelect: (id: string) => void }) {
  const t = useCopy();
  // a count opened the tree at its branch: that branch is brought into view once, on arrival
  useEffect(() => {
    if (at) document.getElementById(`branch-${at}`)?.scrollIntoView?.({ block: "start" });
  }, [at]);
  return (
    <ul className="grid gap-2" aria-label={t("modules.tree.label")} data-testid="module-tree">
      {branches.map((b) => (
        <li key={b.branch} id={`branch-${b.branch}`} className="scroll-mt-4" data-testid={`tree-branch-${b.branch}`} data-at={b.branch === at || undefined}>
          <div className={cn("flex items-baseline gap-2 rounded-sm px-1.5 py-1 font-semibold", b.branch === at && "bg-sunken")}>
            {branchLabel(t, b.branch)} <span className="text-12 font-normal tabular-nums text-subtle">{b.count}</span>
          </div>
          <ul className="ml-4 grid gap-0.5 border-l border-line-subtle pl-3">
            {b.nodes.map((n) => (
              <li key={n.id}>
                <TreeEntry n={n} selected={n.id === selected} onSelect={onSelect} />
              </li>
            ))}
            {b.nodes.length === 0 ? <li className="px-1.5 py-1 text-13 text-subtle">{t("modules.tree.none")}</li> : null}
            {b.count > b.nodes.length && b.nodes.length > 0 ? <li className="px-1.5 py-1 text-13 text-subtle">{t("modules.tree.more", { n: b.count - b.nodes.length })}</li> : null}
          </ul>
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
  const railRef = useRef<HTMLElement>(null);
  const branches = useMemo(() => branchesOf(slug, tree), [slug, tree]);
  const here = useMemo(() => new Set(branches.flatMap((b) => b.nodes.filter((n) => n.node).map((n) => n.id))), [branches]);
  const chosen = selectedOf(branches, at, node);
  const onSelect = (id: string) => {
    select(id);
    // below 1024px the rail stands under the tree: a pick is followed down to it
    if (!wide) railRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  };
  const code = tree.module.children.map((c) => c.name).join(", ");
  return (
    <div className="lg:flex" data-testid="module-tree-page">
      <div className="grid min-w-0 flex-1 content-start gap-4 bg-app px-5 py-5 max-md:px-3">
        {tree.module.description || code ? (
          <div className="grid gap-1 text-13 text-muted">
            {tree.module.description ? <p className="line-clamp-2 max-w-3xl">{tree.module.description}</p> : null}
            {code ? (
              <p>
                <span className="font-medium text-fg">{t("modules.tree.code")}</span> {code}
              </p>
            ) : null}
          </div>
        ) : null}
        <Tree branches={branches} at={at} selected={chosen?.id ?? null} onSelect={onSelect} />
      </div>
      <aside ref={railRef} className="min-w-0 flex-none scroll-mt-4 lg:w-88 border-t border-line-subtle bg-surface px-5 py-5 max-md:px-3 lg:border-t-0 lg:border-l" aria-label={t("modules.rail.relations")} data-testid="module-rail">
        <div className="lg:sticky lg:top-4">
          {chosen?.node ? (
            <NodeRail node={chosen.node} slug={slug} here={here} names={names} readsDays={tree.readsWindowDays} onSelect={onSelect} />
          ) : (
            <p className="text-13 text-subtle">{t("modules.rail.pick")}</p>
          )}
        </div>
      </aside>
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
      <DetailHeader back={{ href: modulesHref(slug), label: t("modules.title") }} title={t("modules.unplaced")} />
      <DetailMobileTitle title={t("modules.unplaced")} />
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
      <DetailHeader back={{ href: modulesHref(slug), label: t("modules.title") }} title={tree?.module.name ?? names.get(moduleSlug) ?? t("modules.loadingOne")} />
      <DetailMobileTitle title={tree?.module.name ?? names.get(moduleSlug) ?? t("modules.loadingOne")} />
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
