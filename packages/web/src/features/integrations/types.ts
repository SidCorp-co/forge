export type IntegrationProvider = 'coolify';
export type IntegrationEnvironment = 'staging' | 'prod';

export interface CoolifyConfigInput {
  baseUrl: string;
  resourceUuid: string;
  branch: string;
}

export interface CoolifySecretsInput {
  apiToken: string;
}

export interface IntegrationSummary {
  id: string;
  projectId: string;
  provider: IntegrationProvider;
  environment: IntegrationEnvironment;
  config: CoolifyConfigInput & { environment?: IntegrationEnvironment };
  active: boolean;
  lastHealthStatus: 'ok' | 'degraded' | 'error' | null;
  lastHealthAt: string | null;
  breakerOpenedAt: string | null;
  hasSecrets: boolean;
  integrationSecretSet: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateIntegrationInput {
  provider: IntegrationProvider;
  environment: IntegrationEnvironment;
  config: CoolifyConfigInput;
  secrets: CoolifySecretsInput;
}

export interface UpdateIntegrationInput {
  config?: Partial<CoolifyConfigInput>;
  secrets?: CoolifySecretsInput;
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
