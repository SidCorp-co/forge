import { index, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { devices } from './schema-devices.js';
import { projects } from './schema-projects.js';

/**
 * Short-lived, single-use capability tickets for out-of-band attachment uploads
 * (the presigned-URL pattern). `POST /api/conversations/:id/attachments` mints
 * a row; the holder PUTs file bytes to /api/uploads/:id with no bearer — possession of the unguessable id +
 * not-expired + not-consumed IS the authorization. All upload params are stored
 * server-side here so the URL cannot be tampered with.
 */
export const uploadTickets = pgTable(
  'upload_tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    uploaderId: uuid('uploader_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    uploaderDeviceId: uuid('uploader_device_id').references(() => devices.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    mime: text('mime').notNull(),
    maxBytes: integer('max_bytes').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    targetIdx: index('upload_tickets_target_idx').on(t.targetType, t.targetId),
    expiresIdx: index('upload_tickets_expires_at_idx').on(t.expiresAt),
  }),
);

export const downloadTickets = pgTable(
  'download_tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    targetType: text('target_type').notNull(),
    attachmentId: uuid('attachment_id').notNull(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    issuedToUserId: uuid('issued_to_user_id').references(() => users.id, { onDelete: 'set null' }),
    issuedToDeviceId: uuid('issued_to_device_id').references(() => devices.id, {
      onDelete: 'set null',
    }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    fetchCount: integer('fetch_count').notNull().default(0),
    lastFetchedAt: timestamp('last_fetched_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    attachmentIdx: index('download_tickets_attachment_idx').on(t.targetType, t.attachmentId),
    expiresIdx: index('download_tickets_expires_at_idx').on(t.expiresAt),
  }),
);
