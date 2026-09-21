/**
 * The integration tables' own vocabulary — the values their columns are constrained to and the
 * shapes they store as `jsonb` — apart from `schema.ts`, which is the table registry and grows a
 * declaration per column otherwise. It holds no table, so it imports nothing and nothing cycles.
 */

export const integrationOwnerTypes = ['user', 'org'] as const;
export type IntegrationOwnerType = (typeof integrationOwnerTypes)[number];

export const integrationDeliveryDirections = ['outbound', 'inbound'] as const;
export type IntegrationDeliveryDirection = (typeof integrationDeliveryDirections)[number];

/**
 * `refused` (ISS-1140) is a call turned away AT the door — a missing or invalid signature on
 * `POST /api/webhooks/in/:slug` — and is not `failed`, which means a delivery that was accepted
 * and then could not be processed. The circuit breaker counts `failed` outbound rows, and must
 * never start counting door refusals as provider failures.
 */
export const integrationDeliveryStatuses = ['pending', 'ok', 'failed', 'refused'] as const;
export type IntegrationDeliveryStatus = (typeof integrationDeliveryStatuses)[number];

/**
 * What a provider answered when asked where it will call in (ISS-1140, `integrations/inbound-door`).
 *
 * `url` is what it holds, verbatim, and `null` is it answering that it holds none. A `readError`
 * means the question could not be put and the row asserts nothing about the endpoint — an
 * observation that failed is not an observation of an absent endpoint.
 */
export interface ObservedEndpoint {
  url: string | null;
  active: boolean | null;
  observedAt: string;
  readError?: string;
}
