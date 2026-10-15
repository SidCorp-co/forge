// contract -> packages/core/src/ecosystem/link-read.ts:readBus — the bus, link and builder-run shapes here are core's reads of link-v1 and builder-run-v1 (packages/core/src/ecosystem/link-schema.ts), so a field added or renamed there changes here in the same change

import { projectGlyph } from "@/features/projects";

export type LinkState = "building" | "current" | "behind" | "breaking" | "unverified";

export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped" | "superseded";

/** Where a run read its repository: the branch and when that commit was read. */
interface HeadReading {
  ref: string;
  readAt: string;
  via: string;
}

/** A repository run names the commit it reads; a storefront run has none, and says where it reads instead. */
type BuilderTrigger =
  | { kind: "joined" | "push" | "manual"; sha: string; head?: HeadReading }
  | { kind: "joined" | "push" | "manual"; sha: null; source: "storefront" };

interface SupersededBy {
  run: string;
  reason: string;
}

interface BuilderStep {
  name: string;
  status: StepStatus;
  detail?: string;
}

export interface BusBuilder {
  id: string;
  trigger: BuilderTrigger;
  steps: BuilderStep[];
  /** The stored steps are not the ones the project's current source type derives: supersede it. */
  stepsStale: boolean;
  supersededBy: SupersededBy | null;
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

interface BusContract {
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
  impact: LinkImpact | null;
  updatedAt: string;
}

interface ImpactBreak {
  element: string;
  check: string | null;
  text: string;
  fields: string[];
  callSites: CallSite[];
  outsideContract: string[];
}

interface LinkImpact {
  link: string;
  version: string;
  verdict: "passes" | "breaks";
  reason: "no-breaking-change-touches" | "built-against" | "touched" | "unmeasured";
  breaks: ImpactBreak[];
}

/** A consumption a member's interface declares, and whether any link its builder wrote backs it. */
export interface DeclaredUse {
  consumer: string;
  contract: ContractRef;
  builtAgainst: string;
  usedBy: string[];
  linked: boolean;
}

export interface Bus {
  ecosystem: { id: string; slug: string; name: string };
  projects: BusProject[];
  contracts: BusContract[];
  links: BusLink[];
  declared: DeclaredUse[];
}

/** A git consumer's call site is a file and line; a storefront consumer's is an artefact its provider holds. */
interface CallSite {
  path?: string;
  line?: number;
  artefact?: { kind: string; id: string };
  operation: string;
}

export const callSiteAt = (s: CallSite): string =>
  s.artefact ? `${s.artefact.kind}:${s.artefact.id}` : `${s.path}:${s.line}`;

interface LinkDocument {
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

type Finding =
  | { classification: "matched"; site: CallSite; contract: ContractRef }
  | { classification: "outside_ecosystem"; site: CallSite; host: string }
  | { classification: "unknown"; site: CallSite; note?: string };

export interface BuilderRunRecord {
  revision: number;
  writer: string;
  document: {
    id: string;
    trigger: BuilderTrigger;
    steps: BuilderStep[];
    findings: Finding[];
    supersededBy?: SupersededBy;
    links: string[];
    createdAt: string;
    updatedAt: string;
  };
}

export type Verdict = "breaks" | "passes" | "unchecked";

// Impact is core's check of the contract's latest version against each link's fields used, call sites and outside-contract surface; a link core has no version to check against is unchecked, never passed
export function impactOf(link: BusLink): Verdict {
  return link.impact?.verdict ?? "unchecked";
}

export const initials = (slug: string) => {
  const parts = slug.split(/[-_.\s]+/).filter(Boolean);
  const two = parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : slug.slice(0, 2);
  return two.toUpperCase();
};

/** The design ProjectMark's props for a member, hashed from its slug so it reads the same tile on every ecosystem screen. */
export const projectMarkProps = (slug: string) => ({ ...projectGlyph(slug), initials: initials(slug), radius: "var(--r-sm)" });

export const shortSha = (sha: string) => sha.slice(0, 7);
