import { AGREEMENT_CHANGES } from '@forge/contracts/agreements';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
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
 * Every change a project made to its working agreements (REQ-90): an override of a Forge default, an
 * agreement of its own, a restore of the default or the retirement of its own. The project's current
 * change to an agreement is its highest revision; a `restore` or `retire` as the highest means it
 * holds none. Owned by `agreements`; insert-only (trigger `project_agreement_revisions_guard`), so a
 * run's recorded revision can always be read back. Forge's defaults are not here: they ship in core
 * (`agreements/forge-defaults.ts`).
 */
export const projectAgreementRevisions = pgTable(
  'project_agreement_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    /** 1, 2, ... per project and slug. */
    revision: integer('revision').notNull(),
    change: text('change', { enum: AGREEMENT_CHANGES }).notNull(),
    /** An addition's name; null for a change to a Forge default, which keeps the default's name. */
    name: text('name'),
    /** The one-sentence rule; null for a restore or a retire. */
    rule: text('rule'),
    detail: text('detail'),
    /** `{ labels?, categories? }`: when it applies; null for always. */
    condition: jsonb('condition'),
    reason: text('reason').notNull(),
    /** The Forge default revision an override was written over; null otherwise. */
    baseRevision: integer('base_revision'),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    revisionUq: uniqueIndex('project_agreement_revisions_revision_uq').on(
      t.projectId,
      t.slug,
      t.revision,
    ),
    projectIdx: index('project_agreement_revisions_project_idx').on(t.projectId, t.createdAt),
    changeChk: check(
      'project_agreement_revisions_change_chk',
      sql`${t.change} IN (${inList(AGREEMENT_CHANGES)})`,
    ),
    ruleChk: check(
      'project_agreement_revisions_rule_chk',
      sql`(${t.change} IN ('override', 'addition')) = (${t.rule} IS NOT NULL)`,
    ),
    reasonChk: check('project_agreement_revisions_reason_chk', sql`length(btrim(${t.reason})) > 0`),
  }),
);
