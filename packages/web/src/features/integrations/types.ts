export type IntegrationProvider = 'coolify' | 'epodsystem';
export type IntegrationEnvironment = 'staging' | 'prod';

export interface CoolifyConfigInput {
  baseUrl: string;
  resourceUuid: string;
  branch: string;
}

export interface CoolifySecretsInput {
  apiToken: string;
}

// ISS-387 — Epodsystem storefront integration. One store per project; the
// `crmk_` key is the only secret. The endpoint is fixed platform config
// (EPODSYSTEM_ENDPOINT env), NOT user input. Store identity fields are filled
// by the test-connection healthcheck, so every config field is optional.
export interface EpodsystemConfigInput {
  storeSlug?: string;
  storeName?: string;
  themeId?: string;
  draftThemeId?: string;
  commerceEnabled?: boolean;
}

export interface EpodsystemSecretsInput {
  apiKey: string;
}

/**
 * Permissive read-shape for the list/summary response. The server returns a
 * provider-specific `config` jsonb; consumers narrow by `provider`. Every
 * provider field is optional here so both the Coolify and Epodsystem sections
 * read it without per-provider casts.
 */
export interface IntegrationConfig {
  // coolify
  baseUrl?: string;
  resourceUuid?: string;
  branch?: string;
  // epodsystem
  orgId?: string;
  scopes?: string[];
  storeId?: string;
  storeSlug?: string;
  storeName?: string;
  themeId?: string;
  themeName?: string;
  draftThemeId?: string;
  commerceEnabled?: boolean;
  domain?: string;
  environment?: IntegrationEnvironment;
}

export interface IntegrationSummary {
  id: string;
  projectId: string;
  provider: IntegrationProvider;
  environment: IntegrationEnvironment;
  config: IntegrationConfig;
  active: boolean;
  lastHealthStatus: 'ok' | 'degraded' | 'error' | null;
  lastHealthAt: string | null;
  breakerOpenedAt: string | null;
  hasSecrets: boolean;
  integrationSecretSet: boolean;
  createdAt: string;
  updatedAt: string;
}

export type CreateIntegrationInput =
  | {
      provider: 'coolify';
      environment: IntegrationEnvironment;
      config: CoolifyConfigInput;
      secrets: CoolifySecretsInput;
    }
  | {
      provider: 'epodsystem';
      environment?: IntegrationEnvironment;
      config: EpodsystemConfigInput;
      secrets: EpodsystemSecretsInput;
    };

export interface UpdateIntegrationInput {
  config?: Partial<CoolifyConfigInput> & Partial<EpodsystemConfigInput>;
  secrets?: Partial<CoolifySecretsInput> & Partial<EpodsystemSecretsInput>;
  active?: boolean;
}

export interface HealthCheckResult {
  status: 'ok' | 'degraded' | 'error';
  message?: string;
  diagnostics?: Record<string, unknown>;
}

export interface IntegrationDelivery {
  id: string;
  projectIntegrationId: string;
  direction: 'outbound' | 'inbound';
  eventName: string;
  status: 'pending' | 'ok' | 'failed';
  requestId: string | null;
  payload: Record<string, unknown>;
  response: Record<string, unknown> | null;
  errorMessage: string | null;
  durationMs: number | null;
  createdAt: string;
  completedAt: string | null;
}
