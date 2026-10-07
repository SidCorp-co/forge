
import type { AgentPathKind } from "@forge/contracts/integrations";
import type { ComponentType } from "react";
import type { IconName } from "@/design";
import { useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { copyOr, type ProductCopyKey } from "@/lib/i18n/product-copy";
import { agent } from "./agent";
import { autoflow } from "./autoflow";
import { coolify } from "./coolify";
import { epodsystem } from "./epodsystem";
import { github } from "./github";
import { gitlab } from "./gitlab";
import { rocketchat } from "./rocketchat";
import { sentry } from "./sentry";

type ProjectSection = ComponentType<{ projectId: string }>;
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
  /** The binding-tier config keys besides `releaseRunnerLabel`, each a field of its binding-v1 target. */
  bindingKeys: readonly string[];
  /** Where a target field is not its config key one to one: the target from the binding tier, and back. */
  bindingTarget?: {
    toTarget(config: Record<string, unknown>): Record<string, unknown>;
    toConfig(target: Record<string, unknown>): Record<string, unknown>;
  };
  target(config: Record<string, unknown>): string | null;
  /** The project-scoped detail section, or null where the provider has none. */
  section: (() => Promise<{ default: ProjectSection }>) | null;
  /** The connection-tier config form, or null where this provider has nothing to edit there. */
  connectionSection: (() => Promise<{ default: ConnectionSection }>) | null;
  /** Where this provider's credential or config is kept instead, as a copy key. */
  connectionNote: ProductCopyKey | null;
}

/** Every provider this build knows, in the order a list renders them. */
export const PROVIDER_MODULES: readonly ProviderModule[] = [
  coolify,
  epodsystem,
  sentry,
  rocketchat,
  github,
  gitlab,
  agent,
  autoflow,
];

const byName = new Map(PROVIDER_MODULES.map((m) => [m.provider, m]));

export function providerModule(provider: string): ProviderModule | undefined {
  return byName.get(provider);
}

/** Every provider name, for a refusal that names the legal set. */
export function providerNames(): string[] {
  return PROVIDER_MODULES.map((m) => m.provider);
}

/** The label, falling back to the raw name — which is true, if bare; in `language` where the locale file words it. */
export function providerLabel(provider: string, language?: string): string {
  const label = byName.get(provider)?.label ?? provider;
  return language ? copyOr(language, `integrations.provider.${provider}`, label) : label;
}

/** A provider's label in the interface language. */
export function useProviderLabel(): (provider: string) => string {
  const language = useInterfaceLanguage();
  return (provider) => providerLabel(provider, language);
}

/** The replace-key box's placeholder in `language`: a token prefix stays as it is, a described token is worded. */
export function secretPlaceholderOf(provider: string, language: string): string | null {
  const placeholder = byName.get(provider)?.secretPlaceholder ?? null;
  return placeholder === null ? null : copyOr(language, `integrations.secret.${provider}`, placeholder);
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
