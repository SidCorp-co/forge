import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import * as ints from './schema-integration-types.js';
import { integrationBindings } from './schema-project-config.js';

// secrets_enc columns hold the AES-256-GCM ciphertext produced by src/integrations/vault.ts.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const integrationDeliveries = pgTable(
  'integration_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bindingId: uuid('binding_id').references(() => integrationBindings.id, {
      onDelete: 'cascade',
    }),
    direction: text('direction', { enum: ints.integrationDeliveryDirections }).notNull(),
    eventName: text('event_name').notNull(),
    requestId: text('request_id'),
    status: text('status', { enum: ints.integrationDeliveryStatuses }).notNull().default('pending'),
    payload: jsonb('payload').notNull().default({}),
    response: jsonb('response'),
    errorMessage: text('error_message'),
    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    bindingCreatedIdx: index('integration_deliveries_binding_created_idx').on(
      t.bindingId,
      sql`${t.createdAt} DESC`,
    ),
    // A dispatch keyed by (binding, requestId) is deduped at the database.
    bindingRequestIdUq: uniqueIndex('integration_deliveries_binding_request_id_uq')
      .on(t.bindingId, t.requestId)
      .where(sql`request_id IS NOT NULL`),
  }),
);

export const integrationDeliveriesRelations = relations(integrationDeliveries, ({ one }) => ({
  binding: one(integrationBindings, {
    fields: [integrationDeliveries.bindingId],
    references: [integrationBindings.id],
  }),
}));

// Additive successor to project_integrations: the CREDENTIAL (connection, owned
// by a principal — user now, org later) is split from the per-project LINK
// (binding). Tables land empty+backfilled; all current read/dispatch paths keep
// using project_integrations until the REST cutover issue flips them. Owner is a
// generic principal so org-level sharing arrives without a data migration.

export const integrationConnections = pgTable(
  'integration_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Generic principal. ownerType discriminates the namespace of ownerId so we
    // can add 'org' later without re-keying rows; no FK because it is polymorphic.
    ownerType: text('owner_type', { enum: ints.integrationOwnerTypes }).notNull().default('user'),
    ownerId: uuid('owner_id').notNull(),
    provider: text('provider').notNull(),
    displayName: text('display_name'),
    // Connection-scoped non-secret config (e.g. coolify baseUrl, epodsystem
    // store identity). Per-project overrides live on the
    // binding.
    config: jsonb('config').notNull().default({}),
    // The ONE encrypted copy of the credential — rotate once, every binding
    // follows. Same <iv:12><tag:16><ct> format as project_integrations.
    secretsEnc: bytea('secrets_enc'),
    active: boolean('active').notNull().default(true),
    breakerOpenedAt: timestamp('breaker_opened_at', { withTimezone: true }),
    lastHealthStatus: text('last_health_status'),
    lastHealthDetail: text('last_health_detail'),
    lastHealthAt: timestamp('last_health_at', { withTimezone: true }),
    inboundEndpointObserved: jsonb('inbound_endpoint_observed').$type<ints.ObservedEndpoint>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ownerProviderIdx: index('integration_connections_owner_provider_idx').on(
      t.ownerType,
      t.ownerId,
      t.provider,
    ),
    activeProviderIdx: index('integration_connections_active_provider_idx')
      .on(t.provider, t.active)
      .where(sql`active = true`),
  }),
);

export const integrationConnectionsRelations = relations(integrationConnections, ({ many }) => ({
  bindings: many(integrationBindings),
}));
