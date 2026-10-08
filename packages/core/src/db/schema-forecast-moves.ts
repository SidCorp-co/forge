import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { projects } from './schema-projects.js';

/**
 * One anchor of one scope's forecast (`forecast/moves.ts`): the event the simulation was anchored on
 * and the range it gave, written the first time a read meets that anchor and never changed. The row
 * before it is where the dates moved from, so a page says "moved 2 h later because ISS-88 moved to
 * awaiting release" rather than showing a date that slid in silence.
 */
export const forecastMoves = pgTable(
  'forecast_moves',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** `requirement:REQ-7`, or `release:draft`. */
    scope: text('scope').notNull(),
    anchoredAt: timestamp('anchored_at', { withTimezone: true }).notNull(),
    p50At: timestamp('p50_at', { withTimezone: true }).notNull(),
    p85At: timestamp('p85_at', { withTimezone: true }).notNull(),
    /** The anchor's event as said (`@forge/contracts/said`). */
    event: jsonb('event').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    anchorUq: uniqueIndex('forecast_moves_anchor_uq').on(t.projectId, t.scope, t.anchoredAt),
    scopeIdx: index('forecast_moves_scope_idx').on(t.projectId, t.scope, t.anchoredAt),
    orderChk: check('forecast_moves_order_chk', sql`${t.p85At} >= ${t.p50At}`),
    eventChk: check('forecast_moves_event_chk', sql`jsonb_typeof(${t.event}) = 'object'`),
  }),
);
