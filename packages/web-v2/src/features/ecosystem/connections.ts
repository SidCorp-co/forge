// The ecosystem page reads the bus as connections: one consumer project using one contract. The bus
// holds one link per consumer MODULE that calls a contract, so a project calling a contract from ten
// modules is ten links and one connection; a declared consumption no link backs is a connection too,
// said as not found in code rather than left out.

import type { Copy } from "@/lib/i18n/product-copy";
import {
  type Bus,
  type BusLink,
  type BusProject,
  type ContractRef,
  type DeclaredUse,
  impactOf,
  type LinkState,
  type Verdict,
} from "./bus";

/** A connection's state: the worst of its links', or `unfound` when the interface declares it and no link backs it. */
export type ConnectionState = LinkState | "unfound";

export interface Connection {
  key: string;
  consumer: string;
  contract: ContractRef;
  /** The links behind it, one per consumer module that calls the contract. */
  modules: BusLink[];
  /** The versions its modules pin, oldest first. */
  uses: string[];
  /** The contract's current version, null when none is recorded. */
  latest: string | null;
  state: ConnectionState;
  /** Operations its modules call that the contract does not publish, summed over modules. */
  outsideContract: number;
  /** The latest version checked against every module: one module it breaks breaks the connection. */
  impact: Verdict;
  declared: DeclaredUse | null;
}

const STATE_ORDER: readonly ConnectionState[] = ["breaking", "behind", "unfound", "unverified", "building", "current"];
const IMPACT_ORDER: readonly Verdict[] = ["breaks", "unchecked", "passes"];

const worstOf = <T>(order: readonly T[], seen: readonly T[], none: T): T => order.find((s) => seen.includes(s)) ?? none;

const keyOf = (consumer: string, c: ContractRef) => `${consumer}>${c.provider}/${c.slug}`;

const byVersion = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

export function connectionsOf(bus: Bus): Connection[] {
  const slug = new Map(bus.projects.map((p) => [p.id, p.slug]));
  const latest = new Map(bus.contracts.map((c) => [`${c.provider}/${c.slug}`, c.currentVersion]));
  const links = new Map<string, BusLink[]>();
  for (const l of bus.links) {
    const key = keyOf(l.consumer, l.contract);
    links.set(key, [...(links.get(key) ?? []), l]);
  }
  const declared = new Map(bus.declared.map((d) => [keyOf(d.consumer, d.contract), d]));
  const keys = [...new Set([...links.keys(), ...declared.keys()])];
  const connections = keys.map((key): Connection => {
    const modules = links.get(key) ?? [];
    const use = declared.get(key) ?? null;
    const first = modules[0] ?? (use as DeclaredUse);
    return {
      key,
      consumer: first.consumer,
      contract: first.contract,
      modules,
      uses: [...new Set(modules.map((l) => l.pinnedVersion))].sort(byVersion),
      latest: latest.get(`${first.contract.provider}/${first.contract.slug}`) ?? null,
      state: modules.length === 0 ? "unfound" : worstOf(STATE_ORDER, modules.map((l) => l.state), "current"),
      outsideContract: modules.reduce((n, l) => n + l.outsideContract, 0),
      impact: modules.length === 0 ? "unchecked" : worstOf(IMPACT_ORDER, modules.map(impactOf), "passes"),
      declared: use,
    };
  });
  const name = (c: Connection) => `${slug.get(c.consumer) ?? c.consumer} ${c.contract.slug}`;
  return connections.sort((a, b) => name(a).localeCompare(name(b)));
}

export type Attention =
  | { kind: "breaking" | "breaks" | "behind" | "unfound" | "outside"; key: string; connection: Connection }
  | { kind: "builderFailed"; key: string; project: BusProject; step: string };

/** What on the page asks someone to act, most urgent first: one entry per fact, each naming its own next step. */
export function attentionOf(bus: Bus, connections: readonly Connection[]): Attention[] {
  const of = (kind: Exclude<Attention["kind"], "builderFailed">, pick: (c: Connection) => boolean): Attention[] =>
    connections.filter(pick).map((connection) => ({ kind, key: `${kind}:${connection.key}`, connection }));
  const failed = bus.projects.flatMap((project): Attention[] => {
    const step = project.builder?.steps.find((s) => s.status === "failed");
    return step ? [{ kind: "builderFailed", key: `builderFailed:${project.id}`, project, step: step.name }] : [];
  });
  return [
    ...of("breaking", (c) => c.state === "breaking"),
    ...of("breaks", (c) => c.impact === "breaks" && c.state !== "breaking"),
    ...of("behind", (c) => c.state === "behind"),
    ...of("unfound", (c) => c.state === "unfound"),
    ...of("outside", (c) => c.outsideContract > 0),
    ...failed,
  ];
}

/** How many connections the summary names before it counts the rest. */
const NAMED = 3;

/** The page's first line: who is here, who uses what from whom, and whether anything needs attention. */
export function summaryOf(bus: Bus, connections: readonly Connection[], attention: readonly Attention[], t: Copy): string {
  const slug = (id: string) => bus.projects.find((p) => p.id === id)?.slug ?? t("ecosystem.overview.aMember");
  const n = bus.projects.length;
  const parts = [n === 1 ? t("ecosystem.overview.projectsOne") : t("ecosystem.overview.projectsMany", { n })];
  for (const c of connections.slice(0, NAMED)) {
    const vars = { consumer: slug(c.consumer), provider: slug(c.contract.provider), contract: c.contract.slug };
    parts.push(c.state === "unfound" ? t("ecosystem.overview.declares", vars) : t("ecosystem.overview.uses", vars));
  }
  if (connections.length > NAMED) parts.push(t("ecosystem.overview.more", { n: connections.length - NAMED }));
  if (connections.length === 0) parts.push(t("ecosystem.overview.unused"));
  else if (attention.length === 0) parts.push(t("ecosystem.overview.allCurrent"));
  if (attention.length === 1) parts.push(t("ecosystem.overview.attentionOne"));
  if (attention.length > 1) parts.push(t("ecosystem.overview.attentionMany", { n: attention.length }));
  return parts.join(" · ");
}
