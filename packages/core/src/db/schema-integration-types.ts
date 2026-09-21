// The integration tables' vocabulary, out of `schema.ts` so that registry grows no declaration per column; it holds no table, so it imports nothing and nothing cycles. What each value means is stated where it governs something: `refused` in `integrations/inbound-door.ts`, `ObservedEndpoint.readError` in `integrations/github/hook-config.ts`.

export const integrationOwnerTypes = ['user', 'org'] as const;
export type IntegrationOwnerType = (typeof integrationOwnerTypes)[number];

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
