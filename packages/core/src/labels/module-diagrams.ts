/**
 * ISS-950 (Tier 3c of ISS-587) — the four diagram kinds, generated from the module taxonomy and
 * the knowledge nodes bound to it. Pure: a snapshot in, Mermaid text out.
 *
 * There is no cache and no schedule here, and that is the regeneration rule rather than an
 * omission of it: a diagram computed on the read from the rows as they are cannot be older than
 * the node it claims to render, because there is nothing between the two to go stale.
 */

import {
  type FlowArrow,
  type ModuleFlow,
  ModuleFlowParseError,
  parseModuleFlow,
} from './module-diagram-flow.js';

export const moduleDiagramKinds = ['mindmap', 'context', 'user-flow', 'swimlane'] as const;
export type ModuleDiagramKind = (typeof moduleDiagramKinds)[number];

export interface ModuleNodeSnapshot {
  body: string;
  relatedIssueCount: number;
  actor: string | null;
}

export interface ModuleSnapshot {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  node: ModuleNodeSnapshot | null;
}

/** A pair of modules that share at least one issue, and how many they share. */
export interface CoOccurrence {
  aId: string;
  bId: string;
  issueCount: number;
}

/** A `knowledge_edges` triple both of whose ends resolved to a module of this project. */
export interface DeclaredModuleEdge {
  fromId: string;
  toId: string;
  predicate: string;
}

export interface ModuleDiagramSnapshot {
  projectName: string;
  modules: ModuleSnapshot[];
  coOccurrences: CoOccurrence[];
  declaredEdges: DeclaredModuleEdge[];
}

export type ModuleDiagramErrorCode = 'NO_MODULES' | 'NO_MODULE_FLOWS' | 'UNPARSABLE_MODULE_FLOW';

export class ModuleDiagramError extends Error {
  constructor(
    readonly code: ModuleDiagramErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ModuleDiagramError';
  }
}

/** Mermaid node ids are generated, never taken from user text — a slug may hold characters mermaid reads as syntax. */
function nodeId(prefix: string, index: number): string {
  return `${prefix}${index}`;
}

// cm:guard every label goes through here — mermaid reads `"`, `(`, `[` and `#` inside a label as syntax and answers a parse error rather than a diagram, so a module named `API (v2)` is the whole diagram's failure unless its text is escaped at the one place labels are written.
function quote(text: string): string {
  return `"${text.replace(/["#]/g, (c) => `#${c.codePointAt(0)};`)}"`;
}

function childrenOf(modules: ModuleSnapshot[], parentId: string | null): ModuleSnapshot[] {
  return modules
    .filter((m) => m.parentId === parentId)
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * The mindmap: the hierarchy, and on every module that has a node, what that node relates to.
 *
 * A module with no knowledge node is drawn with its name and its place and no count. That is the
 * issue's rule, and it is why the count is absent rather than `(0)`: nothing was counted.
 */
function mindmap(snapshot: ModuleDiagramSnapshot): string {
  const { modules } = snapshot;
  const lines = ['mindmap', `  root((${snapshot.projectName}))`];

  const walk = (parentId: string | null, depth: number): void => {
    for (const module of childrenOf(modules, parentId)) {
      const count = module.node ? ` (${module.node.relatedIssueCount})` : '';
      lines.push(`${'  '.repeat(depth)}${module.name}${count}`);
      walk(module.id, depth + 1);
    }
  };
  walk(null, 2);

  return lines.join('\n');
}

/**
 * The context diagram: modules as nodes, and the two kinds of edge kept visibly apart — a dotted
 * arrow carrying a count is what the issue stream shows, a solid arrow carrying a predicate is
 * what somebody declared.
 */
function context(snapshot: ModuleDiagramSnapshot): string {
  const ids = new Map(snapshot.modules.map((m, i) => [m.id, nodeId('m', i)]));
  const lines = ['flowchart LR'];
  for (const module of snapshot.modules) {
    lines.push(`  ${ids.get(module.id)}[${quote(module.name)}]`);
  }
  for (const pair of snapshot.coOccurrences) {
    const a = ids.get(pair.aId);
    const b = ids.get(pair.bId);
    if (!a || !b) continue;
    lines.push(`  ${a} -.->|${quote(`${pair.issueCount} shared`)}| ${b}`);
  }
  for (const edge of snapshot.declaredEdges) {
    const from = ids.get(edge.fromId);
    const to = ids.get(edge.toId);
    if (!from || !to) continue;
    lines.push(`  ${from} -->|${quote(edge.predicate)}| ${to}`);
  }
  return lines.join('\n');
}

interface ParsedModule {
  module: ModuleSnapshot;
  flow: ModuleFlow;
}

/** Parse every module's stored flow, refusing by name on the first one that cannot be read. */
function parseFlows(modules: ModuleSnapshot[]): ParsedModule[] {
  const parsed: ParsedModule[] = [];
  for (const module of modules) {
    if (!module.node) continue;
    let flow: ModuleFlow | null;
    try {
      flow = parseModuleFlow(module.node.body);
    } catch (err) {
      if (!(err instanceof ModuleFlowParseError)) throw err;
      throw new ModuleDiagramError(
        'UNPARSABLE_MODULE_FLOW',
        `module \`${module.slug}\` stores a flow this generator cannot read: ${err.message}`,
      );
    }
    if (flow) parsed.push({ module, flow });
  }
  if (parsed.length === 0) {
    throw new ModuleDiagramError(
      'NO_MODULE_FLOWS',
      'no module of this project stores a Mermaid flow in its knowledge node',
    );
  }
  return parsed;
}

function arrowLine(indent: string, from: string, to: string, arrow: FlowArrow): string {
  return arrow.label
    ? `${indent}${from} -->|${quote(arrow.label)}| ${to}`
    : `${indent}${from} --> ${to}`;
}

/** The user flow: every module's stored flow, each inside a subgraph of its own so the steps of two modules never merge into one chain they do not have. */
function userFlow(snapshot: ModuleDiagramSnapshot): string {
  const lines = ['flowchart TD'];
  for (const [i, { module, flow }] of parseFlows(snapshot.modules).entries()) {
    const ids = new Map(flow.steps.map((s, j) => [s.id, nodeId(`s${i}_`, j)]));
    lines.push(`  subgraph g${i}[${quote(module.name)}]`);
    for (const step of flow.steps) {
      lines.push(`    ${ids.get(step.id)}[${quote(step.label)}]`);
    }
    for (const arrow of flow.arrows) {
      const from = ids.get(arrow.from);
      const to = ids.get(arrow.to);
      if (from && to) lines.push(arrowLine('    ', from, to, arrow));
    }
    lines.push('  end');
  }
  return lines.join('\n');
}

/**
 * The swimlane: the same steps, regrouped by who performs them.
 *
 * The lane is the node's `metadata.actor` where it declares one and the module's own name where it
 * does not, which is the issue's "lanes from the module or actor in node metadata". Two modules
 * naming the same actor share one lane, which is the whole reason to draw this rather than the
 * user flow a second time.
 */
function swimlane(snapshot: ModuleDiagramSnapshot): string {
  const parsed = parseFlows(snapshot.modules);
  const lanes = new Map<string, string[]>();
  const ids = new Map<string, string>();
  const arrows: string[] = [];

  for (const [i, { module, flow }] of parsed.entries()) {
    const lane = module.node?.actor ?? module.name;
    const rows = lanes.get(lane) ?? [];
    for (const [j, step] of flow.steps.entries()) {
      const id = nodeId(`s${i}_`, j);
      ids.set(`${i}:${step.id}`, id);
      rows.push(`    ${id}[${quote(step.label)}]`);
    }
    lanes.set(lane, rows);
    for (const arrow of flow.arrows) {
      const from = ids.get(`${i}:${arrow.from}`);
      const to = ids.get(`${i}:${arrow.to}`);
      if (from && to) arrows.push(arrowLine('  ', from, to, arrow));
    }
  }

  const lines = ['flowchart LR'];
  for (const [i, [lane, rows]] of [...lanes.entries()].entries()) {
    lines.push(`  subgraph lane${i}[${quote(lane)}]`, ...rows, '  end');
  }
  return [...lines, ...arrows].join('\n');
}

const GENERATORS: Record<ModuleDiagramKind, (s: ModuleDiagramSnapshot) => string> = {
  mindmap,
  context,
  'user-flow': userFlow,
  swimlane,
};

/**
 * The one entry point. A project with no module taxonomy is refused rather than answered with an
 * empty frame: an empty mindmap and a project nobody has classified render identically, and only
 * one of them is a diagram.
 */
export function generateModuleDiagram(
  kind: ModuleDiagramKind,
  snapshot: ModuleDiagramSnapshot,
): string {
  if (snapshot.modules.length === 0) {
    throw new ModuleDiagramError(
      'NO_MODULES',
      'this project has no modules, so there is no taxonomy to draw',
    );
  }
  return GENERATORS[kind](snapshot);
}
