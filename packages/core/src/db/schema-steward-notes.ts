import { STEWARD_NOTE_SUBJECT_KINDS } from '@forge/contracts/steward';
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
import { users } from './schema-auth.js';
import { projects } from './schema-projects.js';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/**
 * The steward's two-line note on a requirement or a feedback item (REQ-48 BC-7, BC-8): what happened
 * and what blocks, then what is next and by when, each claim vetted against the standing at write.
 * Insert-only (trigger `steward_notes_guard`): a write supersedes the current row in the same
 * transaction, so `superseded_at` is the one column that ever changes, once.
 */
export const stewardNotes = pgTable(
  'steward_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    subjectKind: text('subject_kind', { enum: STEWARD_NOTE_SUBJECT_KINDS }).notNull(),
    /** The requirement's or feedback item's id; removed with its project. */
    subjectId: uuid('subject_id').notNull(),
    lines: text('lines').array().notNull(),
    cites: jsonb('cites').notNull(),
    claims: jsonb('claims').notNull(),
    /** The standing's basis the note was vetted against (`steward.ts:standingBasisOf`). */
    basis: text('basis').notNull(),
    writtenBy: uuid('written_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** The steward run that wrote it; null for a person's override. */
    runId: uuid('run_id'),
    writtenAt: timestamp('written_at', { withTimezone: true }).notNull().defaultNow(),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
  },
  (t) => ({
    currentUq: uniqueIndex('steward_notes_current_uq')
      .on(t.subjectKind, t.subjectId)
      .where(sql`superseded_at IS NULL`),
    projectIdx: index('steward_notes_project_idx').on(t.projectId),
    subjectKindChk: check(
      'steward_notes_subject_kind_chk',
      sql`${t.subjectKind} IN (${inList(STEWARD_NOTE_SUBJECT_KINDS)})`,
    ),
    linesChk: check('steward_notes_lines_chk', sql`cardinality(${t.lines}) BETWEEN 1 AND 2`),
  }),
);
