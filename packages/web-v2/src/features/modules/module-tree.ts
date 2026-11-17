// The tree read's adapter (ISS-1256): core's `GET /projects/:id/modules/:module/map` turned into the
// branches a module page draws and the right rail of the node it selects. Every reading of the tree
// the page makes is here (which node a link selects, where a relation walks, how a module path is
// named), so a change to the contract changes this file alone. The Unplaced tree is read from the
// pillar's own Unplaced row, which lists what no module holds.

import {
  MODULE_MAP_BRANCHES,
  MODULE_STORED_RELATION_KINDS,
  type ModuleMapBranch,
  type ModuleMapNode,
  type ModuleMapRelationView,
  type ModulePillarResponse,
  type ModuleTreeResponse,
} from "@forge/contracts/module-map";
import { issueHref } from "@/lib/routes/issues";
import { moduleHref } from "@/lib/routes/modules";
import { requirementHref } from "@/lib/routes/requirements";
import { TREE_BRANCHES, type TreeBranch, treeHref } from "./pillar";

/** A node's handle in the address and in a find hit: `<type>:<ref>`, the same as `FindHit.id`. */
export const nodeIdOf = (type: string, ref: string) => `${type}:${ref}`;

/** The first step of a module path: the business module whose tree holds it. */
export const pillarOf = (path: string) => path.split("/")[0] ?? path;

export interface TreeNodeView {
  id: string;
  title: string;
  /** A term's other names beside its title; null for every other node. */
  meta: string | null;
  /** Its one line, read on hover; the rail shows it once the node is picked. */
  summary: string | null;
  /** A rule or a requirement on its way out. */
  retiring: boolean;
  /** Where a node with no rail opens (an issue, an unplaced requirement); null where it selects. */
  href: string | null;
  /** The node the rail reads; null for an issue in flight or an unplaced item. */
  node: ModuleMapNode | null;
}

export interface TreeBranchView {
  branch: TreeBranch;
  /** How many the branch holds; more than `nodes` where core lists only the first. */
  count: number;
  nodes: TreeNodeView[];
}

const RETIRING = new Set(["deprecated", "retired", "superseded", "dropped"]);

export function aliasesOf(node: ModuleMapNode): string[] {
  const a = node.aliases;
  return a ? [...(a.vi ?? []), ...(a.code ?? []), ...(a.industry ?? [])] : [];
}

function nodeView(node: ModuleMapNode): TreeNodeView {
  const aliases = aliasesOf(node);
  return {
    id: nodeIdOf(node.type, node.ref),
    title: node.title,
    meta: aliases.length > 0 ? aliases.join(" · ") : null,
    summary: node.summary,
    retiring: RETIRING.has(node.status ?? ""),
    href: null,
    node,
  };
}

/** The seven branches of one module, in the pillar's column order, "In flight" last. */
export function branchesOf(slug: string, tree: ModuleTreeResponse): TreeBranchView[] {
  return [
    ...MODULE_MAP_BRANCHES.map((b) => ({ branch: b, count: tree.branches[b].length, nodes: tree.branches[b].map(nodeView) })),
    {
      branch: "inflight" as const,
      count: tree.openIssues,
      nodes: tree.inFlight.map((i) => ({ id: nodeIdOf("issue", i.key), title: `${i.key} ${i.title}`, meta: null, summary: null, retiring: false, href: issueHref(slug, i.key), node: null })),
    },
  ];
}

/** What no module holds, as the pillar's Unplaced row lists it, in the same branches. */
export function unplacedBranchesOf(slug: string, read: ModulePillarResponse): TreeBranchView[] {
  const u = read.unplaced;
  const items = (type: string) => u.items.filter((i) => i.type === type);
  const hrefOf = (type: string, ref: string) => (type === "requirement" ? requirementHref(slug, ref) : type === "issue" ? issueHref(slug, ref) : null);
  return TREE_BRANCHES.map((b) => {
    const type = b === "inflight" ? "issue" : b;
    return {
      branch: b,
      count: b === "inflight" ? u.openIssues : u.counts[b],
      nodes: items(type).map((i) => ({ id: nodeIdOf(type, i.ref), title: i.title, meta: null, summary: null, retiring: false, href: hrefOf(type, i.ref), node: null })),
    };
  });
}

/**
 * The node the rail shows. An address naming a node shows that node, or none where the tree holds no
 * such node (`missing`), never another in its place; an address naming none shows the first of the
 * branch it opened at, else the first there is.
 */
export function selectedOf(branches: readonly TreeBranchView[], at: TreeBranch | null, node: string | null): { chosen: TreeNodeView | null; missing: boolean } {
  const all = branches.flatMap((b) => b.nodes.filter((n) => n.node));
  if (node) {
    const named = all.find((n) => n.id === node) ?? null;
    return { chosen: named, missing: named === null };
  }
  return { chosen: branches.find((b) => b.branch === at)?.nodes.find((n) => n.node) ?? all[0] ?? null, missing: false };
}

/** A module path (`execution/devices`) by the names of its steps a person reads; a step no read names is left out. */
export function pathNameOf(path: string, names: ReadonlyMap<string, string>): string {
  return path
    .split("/")
    .map((s) => names.get(s))
    .filter(Boolean)
    .join(" › ");
}

/** The slugs this tree can name: the module, its parent and its children, beside the pillar's. */
export function treeNamesOf(tree: ModuleTreeResponse, pillar: ReadonlyMap<string, string>): Map<string, string> {
  const m = tree.module;
  return new Map([...pillar, [m.slug, m.name], ...(m.parent ? [[m.parent.slug, m.parent.name] as const] : []), ...m.children.map((c) => [c.slug, c.name] as const)]);
}

/** Where a relation's other end walks: a node on this page, another page, or a search for a code anchor. */
export type RelationTarget = { kind: "select"; id: string } | { kind: "href"; href: string } | { kind: "search"; query: string } | { kind: "none" };

export function relationTarget(slug: string, here: ReadonlySet<string>, rel: ModuleMapRelationView): RelationTarget {
  const o = rel.other;
  if (o.type === "code") return { kind: "search", query: o.ref };
  if (o.type === "module") return { kind: "href", href: moduleHref(slug, pillarOf(o.ref)) };
  // a requirement's end may name one of its criteria (`REQ-12 BC-3`); the tree's node is the requirement
  const key = o.type === "requirement" ? (o.ref.split(" ")[0] ?? o.ref) : o.ref;
  const id = nodeIdOf(o.type, key);
  if (here.has(id)) return { kind: "select", id };
  if (o.module) return { kind: "href", href: treeHref(slug, pillarOf(o.module), o.type, id) };
  if (o.type === "requirement") return { kind: "href", href: requirementHref(slug, key) };
  return { kind: "none" };
}

/** One labelled line of the rail: a relation kind read from the node's side. */
export interface RelationLine {
  /** `used_in.out` reads "Used in", `used_in.in` "Uses". */
  label: `${(typeof MODULE_STORED_RELATION_KINDS)[number]}.${"out" | "in"}`;
  relations: ModuleMapRelationView[];
}

/** The node's stored relations, grouped by kind and direction in the order the model names them. */
export function relationLinesOf(node: ModuleMapNode): RelationLine[] {
  return MODULE_STORED_RELATION_KINDS.flatMap((kind) =>
    (["out", "in"] as const).flatMap((direction) => {
      const relations = node.relations.filter((r) => r.kind === kind && r.direction === direction);
      return relations.length > 0 ? [{ label: `${kind}.${direction}` as const, relations }] : [];
    }),
  );
}

export const isBranch = (v: string | null): v is ModuleMapBranch => (MODULE_MAP_BRANCHES as readonly string[]).includes(v ?? "");
