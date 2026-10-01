// cm:edge contract -> packages/core/src/ecosystem/link-read.ts:readBus — the bus, link and builder-run shapes here are core's reads of link-v1 and builder-run-v1 (packages/core/src/ecosystem/link-schema.ts), so a field added or renamed there changes here in the same change

export const LINK_STATES = ["building", "current", "behind", "breaking", "unverified"] as const;
export type LinkState = (typeof LINK_STATES)[number];

export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export interface BuilderStep {
  name: string;
  status: StepStatus;
  detail?: string;
}

export interface BusBuilder {
  id: string;
  trigger: { kind: "joined" | "push"; sha: string };
  steps: BuilderStep[];
  findings: number;
  links: number;
  createdAt: string;
  updatedAt: string;
}

export interface BusProject {
  id: string;
  slug: string;
  name: string;
  builder: BusBuilder | null;
}

export interface BusContract {
  provider: string;
  slug: string;
  title: string;
  type: string;
  lifecycle: string;
  currentVersion: string | null;
}

export interface ContractRef {
  provider: string;
  slug: string;
}

export interface BusLink {
  id: string;
  consumer: string;
  module: string;
  contract: ContractRef;
  state: LinkState;
  pinnedVersion: string;
  outsideContract: number;
  updatedAt: string;
}

export interface Bus {
  ecosystem: { id: string; slug: string; name: string };
  projects: BusProject[];
  contracts: BusContract[];
  links: BusLink[];
}

export interface CallSite {
  path: string;
  line: number;
  operation: string;
}

export interface LinkDocument {
  id: string;
  ecosystem: string;
  consumer: { project: string; module: string };
  contract: ContractRef;
  pinnedVersion: string;
  state: LinkState;
  callSites: CallSite[];
  fieldsUsed: string[];
  outsideContract: string[];
  notes: string[];
  writtenBy: { runId?: string; sessionId?: string; sha: string };
  refreshedAtSha: string;
  createdAt: string;
  updatedAt: string;
}

export interface LinkRecord {
  revision: number;
  writer: string;
  document: LinkDocument;
  currentVersion: string | null;
}

export type Finding =
  | { classification: "matched"; site: CallSite; contract: ContractRef }
  | { classification: "outside_ecosystem"; site: CallSite; host: string }
  | { classification: "unknown"; site: CallSite; note?: string };

export interface BuilderRunRecord {
  revision: number;
  writer: string;
  document: {
    id: string;
    trigger: { kind: "joined" | "push"; sha: string };
    steps: BuilderStep[];
    findings: Finding[];
    links: string[];
    createdAt: string;
    updatedAt: string;
  };
}

export type Tone = "ok" | "warn" | "bad" | "pend" | "own";

export const STATE_TONE: Record<LinkState, Tone> = {
  current: "ok",
  behind: "warn",
  breaking: "bad",
  building: "pend",
  unverified: "pend",
};

export const STATE_MEANING: Record<LinkState, string> = {
  current: "The version in use is the contract's current one",
  behind: "A newer version of the contract exists",
  breaking: "The version in use no longer works against the contract",
  building: "The consumer's ecosystem builder found the call and is still writing its guide",
  unverified: "The guide is written but nothing has checked it against the contract",
};

export const contractKey = (c: ContractRef) => `${c.provider}/${c.slug}`;

export interface BusRow {
  key: string;
  ref: ContractRef;
  contract: BusContract | null;
  links: BusLink[];
  span: [number, number];
}

// cm:why a link can point at a contract the provider no longer publishes to this ecosystem; it still gets a row, named as unpublished, so the link never vanishes from the bus
export function busRows(bus: Bus): BusRow[] {
  const column = new Map(bus.projects.map((p, i) => [p.id, i]));
  const rows = new Map<string, BusRow>();
  const rowOf = (ref: ContractRef, contract: BusContract | null) => {
    const key = contractKey(ref);
    const held = rows.get(key);
    if (held) return held;
    const row: BusRow = { key, ref, contract, links: [], span: [0, 0] };
    rows.set(key, row);
    return row;
  };
  for (const c of bus.contracts) rowOf({ provider: c.provider, slug: c.slug }, c);
  for (const l of bus.links) rowOf(l.contract, null).links.push(l);
  for (const row of rows.values()) {
    const cols = [row.ref.provider, ...row.links.map((l) => l.consumer)]
      .map((id) => column.get(id))
      .filter((n): n is number => n !== undefined);
    row.span = cols.length ? [Math.min(...cols), Math.max(...cols)] : [0, 0];
  }
  return [...rows.values()];
}

export type Verdict = "breaks" | "older" | "current" | "unknown";

// cm:why Impact reads the version each link pins and the state its master recorded; a field-level check against the next version does not exist yet (ISS-40), so nothing here claims one
export function impactOf(link: BusLink, contract: BusContract | null): Verdict {
  if (link.state === "breaking") return "breaks";
  if (!contract?.currentVersion) return "unknown";
  return link.pinnedVersion === contract.currentVersion ? "current" : "older";
}

export const VERDICT_TONE: Record<Verdict, Tone> = {
  breaks: "bad",
  older: "warn",
  current: "ok",
  unknown: "pend",
};

export interface BuilderProgress {
  done: number;
  total: number;
  running: BuilderStep | null;
  failed: BuilderStep | null;
}

export function builderProgress(b: BusBuilder): BuilderProgress {
  const done = b.steps.filter((s) => s.status === "succeeded" || s.status === "skipped").length;
  return {
    done,
    total: b.steps.length,
    running: b.steps.find((s) => s.status === "running") ?? null,
    failed: b.steps.find((s) => s.status === "failed") ?? null,
  };
}

export const builderActive = (b: BusBuilder | null) =>
  Boolean(b?.steps.some((s) => s.status === "running" || s.status === "pending")) &&
  !b?.steps.some((s) => s.status === "failed");

export const initials = (slug: string) => {
  const parts = slug.split(/[-_.\s]+/).filter(Boolean);
  const two = parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : slug.slice(0, 2);
  return two.toUpperCase();
};

export const shortSha = (sha: string) => sha.slice(0, 7);
