
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

export type ProjectSection = ComponentType<{ projectId: string }>;
export type ConnectionSection = ComponentType<{
  connection: { id: string; config: Record<string, unknown> };
  canManage: boolean;
}>;

export interface ProviderModule {
  provider: string;
  label: string;
  icon: IconName;
  secretField: string | null;
  /** Shown in the replace-key box. Null exactly where `secretField` is. */
  secretPlaceholder: string | null;
  /** Does this provider resolve to a connection a person can drill into (Test / Rotate / Remove)? */
  drillable: boolean;
  agentPathKind: AgentPathKind;
  /** The `mcpServers` key this provider renders under, or null where it renders none. */
  mcpServerName: string | null;
  /** True where every binding injects its own suffixed entry rather than one winner taking the slot. */
  multiBinding: boolean;
  target(config: Record<string, unknown>): string | null;
  /** The project-scoped detail section, or null where the provider has none. */
  section: (() => Promise<{ default: ProjectSection }>) | null;
  /** The connection-tier config form, or null where this provider has nothing to edit there. */
  connectionSection: (() => Promise<{ default: ConnectionSection }>) | null;
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

/** The provider an `mcpServers` key belongs to, or undefined where the key is nobody's. */
export function providerForMcpServerName(name: string): ProviderModule | undefined {
  for (const m of PROVIDER_MODULES) {
    if (m.mcpServerName === null) continue;
    if (name === m.mcpServerName) return m;
    if (m.multiBinding && name.startsWith(`${m.mcpServerName}_`)) return m;
  }
  return undefined;
}
