/** Epodsystem's half of `forge_storefront_target`: the store identity plus its themes, read live. */

import type { StorefrontTargetArgs } from '../index.js';
import { epodsystemEndpoint } from './endpoints.js';
import { fetchStorefrontThemes } from './themes.js';
import type { EpodsystemConfig, EpodsystemSecrets } from './types.js';

async function resolveLiveThemes(
  args: StorefrontTargetArgs,
  config: EpodsystemConfig,
): Promise<Awaited<ReturnType<typeof fetchStorefrontThemes>>> {
  if (!config.storeId) return null;
  try {
    const secrets = args.readSecrets() as EpodsystemSecrets;
    if (!secrets?.apiKey) return null;
    return await fetchStorefrontThemes(secrets.apiKey, config.storeId);
  } catch {
    return null;
  }
}

export async function epodsystemStorefrontTarget(
  args: StorefrontTargetArgs,
): Promise<Record<string, unknown>> {
  const config = args.config as EpodsystemConfig;
  const live = await resolveLiveThemes(args, config);
  return {
    orgId: config.orgId ?? null,
    scopes: config.scopes ?? null,
    storeId: config.storeId ?? null,
    storeSlug: config.storeSlug ?? null,
    storeName: config.storeName ?? null,
    themeId: live?.mainThemeId ?? config.themeId ?? null,
    themeName: config.themeName ?? null,
    draftThemeId: live?.draftThemeId ?? null,
    themes: live?.themes ?? null,
    versions: live?.versions ?? null,
    themesResolvedLive: live !== null,
    commerceEnabled: config.commerceEnabled ?? null,
    // Real primary published domain (best-effort resolved at healthcheck).
    // Live URL = https://<domain>/ ; draft preview = +?preview_token=<token>.
    domain: config.domain ?? null,
    // Fixed platform endpoint (EPODSYSTEM_ENDPOINT env), not per-store config.
    endpoint: epodsystemEndpoint(),
  };
}
