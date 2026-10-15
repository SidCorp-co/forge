// The integration tables' vocabulary, out of `schema.ts` so that registry grows no declaration per column; it holds no table, so it imports nothing and nothing cycles. What each value means is stated where it governs something: `refused` in `integrations/inbound-door.ts`, `ObservedEndpoint.readError` in `integrations/github/hook-config.ts`.

export const integrationOwnerTypes = ['user', 'org', 'instance'] as const;
export type IntegrationOwnerType = (typeof integrationOwnerTypes)[number];

/** The owner id of a connection the instance owns: there is one instance, so it is no row's id. */
export const INSTANCE_OWNER_ID = '00000000-0000-0000-0000-000000000000';

/** How an installation came to be recorded: GitHub's OAuth answer, or a binding that held it first. */
export const githubInstallationProofs = ['oauth', 'bound_before'] as const;
export type GithubInstallationProof = (typeof githubInstallationProofs)[number];

/** Where GitHub's `installation` webhook last left an installation. */
export const githubInstallationStates = ['active', 'suspended', 'gone'] as const;
export type GithubInstallationState = (typeof githubInstallationStates)[number];

export const githubAccountTypes = ['User', 'Organization', 'Enterprise'] as const;
export type GithubAccountType = (typeof githubAccountTypes)[number];

export const integrationDeliveryDirections = ['outbound', 'inbound'] as const;
export type IntegrationDeliveryDirection = (typeof integrationDeliveryDirections)[number];

export const integrationDeliveryStatuses = ['pending', 'ok', 'failed', 'refused'] as const;
export type IntegrationDeliveryStatus = (typeof integrationDeliveryStatuses)[number];

export interface ObservedEndpoint {
  url: string | null;
  active: boolean | null;
  observedAt: string;
  readError?: string;
}
