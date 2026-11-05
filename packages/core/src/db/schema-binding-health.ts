import type { Said } from '@forge/contracts/said';
import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { ObservedEndpoint } from './schema-integration-types.js';
import { integrationBindings } from './schema-project-config.js';

/**
 * What the last health check learned of ONE binding's own target — its repository's visibility, its
 * hooks, its deploy targets, its site — apart from what it learned of the credential, which is the
 * connection's (`integration_connections.last_health_*`) and every binding of it reads alike
 * (ISS-983). An observation the integrations adapter makes, not part of the binding document, so it
 * rests in a table of its own: a probe never touches the binding's `revision`. Read through
 * `integrations/binding-health.ts:bindingHealth`, never alone.
 */
export const integrationBindingHealth = pgTable('integration_binding_health', {
  bindingId: uuid('binding_id')
    .primaryKey()
    .references(() => integrationBindings.id, { onDelete: 'cascade' }),
  status: text('status'),
  /** The sentence behind `status` in English, beside `says`, the said form a page reads in its own language. */
  detail: text('detail'),
  says: jsonb('says').$type<Said>(),
  checkedAt: timestamp('checked_at', { withTimezone: true }),
  /** Where this binding's own hook calls, where the hook is the target's (a GitLab project's). */
  inboundEndpointObserved: jsonb('inbound_endpoint_observed').$type<ObservedEndpoint>(),
});

export type IntegrationBindingHealthRow = typeof integrationBindingHealth.$inferSelect;
