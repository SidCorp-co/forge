import { GATE_PROFILES } from '@forge/contracts/gate-profiles';
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { projects } from './schema-projects.js';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/** Who changed a project's gates: a person, an agent account, or Forge itself after an incident. */
export const GATE_CHANGE_ACTORS = ['person', 'agent', 'forge'] as const;
/** Why: someone set them, or Forge raised the profile after a failed deploy or a rolled-back release. */
export const GATE_CHANGE_CAUSES = ['set', 'deploy_failed', 'release_reverted'] as const;

/**
 * Every change to a project's gate profile or overrides (REQ-76 BC-12, BC-13): who, why, from what
 * to what, and the config revision it wrote. Insert-only (trigger `project_gate_changes_guard`); a
 * row goes only with its project.
 */
export const projectGateChanges = pgTable(
  'project_gate_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    configRevision: integer('config_revision').notNull(),
    profileFrom: text('profile_from', { enum: GATE_PROFILES }),
    profileTo: text('profile_to', { enum: GATE_PROFILES }).notNull(),
    overridesFrom: jsonb('overrides_from').notNull(),
    overridesTo: jsonb('overrides_to').notNull(),
    actorKind: text('actor_kind', { enum: GATE_CHANGE_ACTORS }).notNull(),
    /** The account that wrote it; null where Forge raised it. */
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    cause: text('cause', { enum: GATE_CHANGE_CAUSES }).notNull(),
    reason: text('reason').notNull(),
    /** What the incident was: the release batch or attempt it names; null for a person's or agent's set. */
    ref: text('ref'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectIdx: index('project_gate_changes_project_idx').on(t.projectId, t.createdAt),
    actorChk: check(
      'project_gate_changes_actor_chk',
      sql`${t.actorKind} IN (${inList(GATE_CHANGE_ACTORS)})`,
    ),
    causeChk: check(
      'project_gate_changes_cause_chk',
      sql`${t.cause} IN (${inList(GATE_CHANGE_CAUSES)})`,
    ),
    profileToChk: check(
      'project_gate_changes_profile_to_chk',
      sql`${t.profileTo} IN (${inList(GATE_PROFILES)})`,
    ),
    profileFromChk: check(
      'project_gate_changes_profile_from_chk',
      sql`${t.profileFrom} IS NULL OR ${t.profileFrom} IN (${inList(GATE_PROFILES)})`,
    ),
    forgeHasNoUserChk: check(
      'project_gate_changes_forge_actor_chk',
      sql`(${t.actorKind} = 'forge') = (${t.actorUserId} IS NULL)`,
    ),
    reasonChk: check('project_gate_changes_reason_chk', sql`length(btrim(${t.reason})) > 0`),
  }),
);
