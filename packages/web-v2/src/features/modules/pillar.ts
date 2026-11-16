// The pillar read's adapter (ISS-1256): core's `GET /projects/:id/modules/map` turned into the rows the
// map's landing table draws. Every reading of the pillar the screen makes is here, so a change to the
// contract changes this file alone. Core infers nothing and gates nothing: a gap is only drawn.

import { MODULE_MAP_BRANCHES, type ModuleMapBranch, type ModulePillarResponse } from "@forge/contracts/module-map";
import { FIND_UNPLACED_FILTER } from "@forge/contracts/find";
import { moduleHref } from "@/lib/routes/modules";

/** The tree branches a count opens: the six record branches and the open issues' "In flight". */
export const TREE_BRANCHES = [...MODULE_MAP_BRANCHES, "inflight"] as const;
export type TreeBranch = (typeof TREE_BRANCHES)[number];

/** A branch whose zero is a gap agents are taught to fill: a module with no term or no rule. */
const GAP_WHEN_EMPTY: ReadonlySet<ModuleMapBranch> = new Set(["term", "rule"]);

export interface PillarCell {
  branch: TreeBranch;
  count: number;
  /** The count opens the module's tree at this branch. */
  href: string;
  /** Drawn as a gap (a missing term or rule, or anything unplaced); never refused. */
  gap: boolean;
}

export interface PillarRowView {
  /** The module slug the tree is read by, or `unplaced`. */
  key: string;
  name: string;
  description: string | null;
  unplaced: boolean;
  /** The module's page, its tree. */
  href: string;
  cells: PillarCell[];
}

/** The tree at one branch: the page a count opens. */
export const treeHref = (slug: string, module: string, branch: TreeBranch, node?: string) => {
  const q = new URLSearchParams({ type: branch });
  if (node) q.set("node", node);
  return `${moduleHref(slug, module)}?${q.toString()}`;
};

/** One row per business module, then the Unplaced row: items no module holds, every count a gap. */
export function pillarRowsOf(slug: string, read: ModulePillarResponse): PillarRowView[] {
  const modules = read.modules.map((m): PillarRowView => {
    const cell = (branch: TreeBranch, count: number): PillarCell => ({
      branch,
      count,
      href: treeHref(slug, m.module.slug, branch),
      gap: count === 0 && branch !== "inflight" && GAP_WHEN_EMPTY.has(branch),
    });
    return {
      key: m.module.slug,
      name: m.module.name,
      description: m.description,
      unplaced: false,
      href: moduleHref(slug, m.module.slug),
      cells: [...MODULE_MAP_BRANCHES.map((b) => cell(b, m.counts[b])), cell("inflight", m.openIssues)],
    };
  });
  const u = read.unplaced;
  const cell = (branch: TreeBranch, count: number): PillarCell => ({ branch, count, href: treeHref(slug, FIND_UNPLACED_FILTER, branch), gap: count > 0 });
  return [
    ...modules,
    {
      key: FIND_UNPLACED_FILTER,
      name: "",
      description: null,
      unplaced: true,
      href: moduleHref(slug, FIND_UNPLACED_FILTER),
      cells: [...MODULE_MAP_BRANCHES.map((b) => cell(b, u.counts[b])), cell("inflight", u.openIssues)],
    },
  ];
}

/** A module's name by its slug, for a path core sends as slugs (`execution/devices`): its last step a person can name. */
export function moduleNamesOf(read: ModulePillarResponse | undefined): Map<string, string> {
  return new Map((read?.modules ?? []).map((m) => [m.module.slug, m.module.name]));
}
