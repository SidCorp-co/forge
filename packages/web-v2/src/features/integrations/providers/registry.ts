// The one door onto what the web knows about an integration provider.
//
// Mirrors the role core's `integrations/registry.ts` plays on the server: every generic surface —
// the status cards, both drawers, the directory search, the MCP panel, the pipeline settings tab —
// asks a question here instead of naming a provider. Before ISS-1071 the same seven names were
// written out in seven places (two `PROVIDER_ICON` maps, `PROVIDER_LABEL`, `SECRET_FIELD`,
// `SECRET_PLACEHOLDER`, `DRILLABLE_PROVIDERS`, `connectionTarget`'s key list and a seven-arm
// `ProviderSection`), so adding a provider meant editing all of them and a missed one failed
// silently — a GitHub connection fell through `SECRET_FIELD` to `apiKey`, and a Sentry one fell
// through `ConfigSection` into Postman's form.
//
// cm:edge contract -> packages/core/src/integrations/registry.ts — the two registries are one
// vocabulary written twice. Nothing type-checks the pair: `@forge/contracts` re-exports core's
// `IntegrationProvider` but the declarations themselves import `@forge/core/public`, which a
// browser build cannot resolve, so a provider added to core and not to this file renders here with
// a raw name, a `link` icon and no section.

import type { AgentPathKind } from "@forge/contracts";
import type { ComponentType } from "react";
import type { IconName } from "@/design";
import { agent } from "./agent";
import { coolify } from "./coolify";
import { epodsystem } from "./epodsystem";
import { github } from "./github";
import { google } from "./google";
import { postman } from "./postman";
import { rocketchat } from "./rocketchat";
import { sentry } from "./sentry";

/** A section rendered inside a drawer — every one takes the project it is scoped to. */
export type ProjectSection = ComponentType<{ projectId: string }>;
/** A connection-tier form in the workspace edit drawer. */
export type ConnectionSection = ComponentType<{
  connection: { id: string; config: Record<string, unknown> };
  canManage: boolean;
}>;

// cm:why the two section refs are thunks rather than components: `derive.ts` and
// `connection-identity.ts` are pure modules whose tests run under vitest's node environment, and
// they read this registry. Holding the components directly would pull every provider's JSX — and
// the whole design system — into those runs.
export interface ProviderModule {
  provider: string;
  /** What an operator calls it. */
  label: string;
  icon: IconName;
  // cm:edge contract -> packages/core/src/integrations/rotation.ts — `PRIMARY_FIELD` is the other half of this name; one that disagrees writes a secrets blob the provider's schema refuses, and the fall-through it replaced sent every GitHub and Google key to `apiKey`
  /** The secrets key carrying the primary credential, or null where it is never typed by hand. */
  secretField: string | null;
  /** Shown in the replace-key box. Null exactly where `secretField` is. */
  secretPlaceholder: string | null;
  /** Does this provider resolve to a connection a person can drill into (Test / Rotate / Remove)? */
  drillable: boolean;
  // cm:edge contract -> packages/core/src/integrations/types.ts — `AgentPath['kind']` is declared per provider there and projected onto `BindingSummary.agentPathKind`; this copy exists only for the connect flow, where no binding exists yet to read it off
  /**
   * How far a grant reaches for this provider, so a control can say what granting MEANS without
   * knowing which provider it is looking at. A saved binding carries its own `agentPathKind` off
   * the wire and that value wins wherever one is in hand.
   */
  agentPathKind: AgentPathKind;
  /** The `mcpServers` key this provider renders under, or null where it renders none. */
  mcpServerName: string | null;
  /** True where every binding injects its own suffixed entry rather than one winner taking the slot. */
  multiBinding: boolean;
  /**
   * The endpoint, workspace or account this credential points at — the second thing that tells two
   * connections of one provider apart. Null when the config carries nothing identifying.
   * Reads CONFIG, the non-secret tier: everything returned here is rendered into the DOM.
   */
  target(config: Record<string, unknown>): string | null;
  /** The project-scoped detail section, or null where the provider has none. */
  section: (() => Promise<{ default: ProjectSection }>) | null;
  /** The connection-tier config form, or null where this provider has nothing to edit there. */
  connectionSection: (() => Promise<{ default: ConnectionSection }>) | null;
  /**
   * Rendered in place of `connectionSection` when it is null. Says where this provider's config IS
   * edited rather than leaving the pane blank — the branch this replaced fell through to Postman's
   * form, so a Sentry connection offered "Workspace name / Region / Mode" and saved it.
   */
  connectionNote: string | null;
}

/** Every provider this build knows, in the order a list renders them. */
export const PROVIDER_MODULES: readonly ProviderModule[] = [
  coolify,
  postman,
  epodsystem,
  sentry,
  rocketchat,
  github,
  google,
  agent,
];

const byName = new Map(PROVIDER_MODULES.map((m) => [m.provider, m]));

export function providerModule(provider: string): ProviderModule | undefined {
  return byName.get(provider);
}

/** Every provider name, for a refusal that names the legal set. */
export function providerNames(): string[] {
  return PROVIDER_MODULES.map((m) => m.provider);
}

/** The label, falling back to the raw name — which is true, if bare. */
export function providerLabel(provider: string): string {
  return byName.get(provider)?.label ?? provider;
}

export function providerIcon(provider: string): IconName {
  return byName.get(provider)?.icon ?? "link";
}

export function isDrillableProvider(provider: string): boolean {
  return byName.get(provider)?.drillable === true;
}

/** The one-line identity for a connection of this provider. */
export function connectionTargetFor(
  provider: string,
  config: Record<string, unknown> | null | undefined,
): string | null {
  return byName.get(provider)?.target(config ?? {}) ?? null;
}

// cm:guard the suffix arm is what `multiBinding` MEANS and is the one place the web states the rule — core states it once in `mcpServerNameFor`, and writing it out per provider is what put the same prefix test in four places on the server
/** The provider an `mcpServers` key belongs to, or undefined where the key is nobody's. */
export function providerForMcpServerName(name: string): ProviderModule | undefined {
  for (const m of PROVIDER_MODULES) {
    if (m.mcpServerName === null) continue;
    if (name === m.mcpServerName) return m;
    if (m.multiBinding && name.startsWith(`${m.mcpServerName}_`)) return m;
  }
  return undefined;
}
