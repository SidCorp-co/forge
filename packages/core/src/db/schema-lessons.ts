import {
  CORRECTION_ITEM_KINDS,
  CORRECTION_SOURCES,
  LESSON_ABOUTS,
  LESSON_CONFUSION_KINDS,
  LESSON_ITEM_KINDS,
  LESSON_OUTPUT_KINDS,
  LESSON_RESOLUTIONS,
  LESSON_SCOPE_KINDS,
  LESSON_STATUSES,
} from '@forge/contracts/lessons';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { feedback } from './schema-feedback.js';
import { issues } from './schema-issues.js';
import { projects } from './schema-projects.js';
import { requirementAreas } from './schema-requirements.js';
import { actorAgencies } from './schema-vocabulary.js';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

// a lesson (L-n, REQ-50) is one sentence learned from corrections: proposed and approved by the
// steward, held while a confusion about it is open and retired when it no longer serves; its
// status moves only through the kernel (`lesson-machine.ts`), and while approved its text reaches the
// agents in its scope as the knowledge entry `lesson-<n>` (docs/proposals/lessons.md, section 2)
export const lessons = pgTable(
  'lessons',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    sentence: text('sentence').notNull(),
    scopeKind: text('scope_kind', { enum: LESSON_SCOPE_KINDS }).notNull(),
    // no action, so an area a lesson is scoped to is not deleted from under it
    scopeAreaId: uuid('scope_area_id').references(() => requirementAreas.id),
    scopeItemKind: text('scope_item_kind', { enum: LESSON_ITEM_KINDS }),
    /**
     * What it is about, set by whoever drafts it (0643, ISS-1167): `app` or `process`. Null on a row
     * drafted before, where an area lesson was backfilled `app` and every other one is owed its
     * classification; its scope is never read for it.
     */
    about: text('about', { enum: LESSON_ABOUTS }),
    status: text('status', { enum: LESSON_STATUSES }).notNull().default('proposed'),
    proposedBy: uuid('proposed_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    proposedAgency: text('proposed_agency', { enum: actorAgencies }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    /** Why it was rejected or retired. */
    decidedReason: text('decided_reason'),
    appliedCount: integer('applied_count').notNull().default(0),
    // the 30-day unused clock reads this and `approved_at` alone (BC-7); 0522 folded a person's old
    // `kept_at` into it where that was later, so no row's clock moved when the column went
    lastAppliedAt: timestamp('last_applied_at', { withTimezone: true }),
    // the two links to another lesson are foreign keys on the table (below), not column references:
    // a column referencing its own table makes the row type circular wherever it is inferred first
    supersedesId: uuid('supersedes_id'),
    supersededById: uuid('superseded_by_id'),
    checkIssueId: uuid('check_issue_id').references(() => issues.id, { onDelete: 'set null' }),
    /** The Forge feedback a process lesson was routed to, in place of a check issue (0638, ISS-1136). */
    routedFeedbackId: uuid('routed_feedback_id').references(() => feedback.id, {
      onDelete: 'set null',
    }),
    /**
     * What it is about (0667, ISS-1251): `card:<id>`, `REQ-<n> BC-<m>` or `<path>[:<symbol>]`. Null on
     * a lesson drafted before, which the steward anchors from its record or lists as owing one.
     */
    anchor: text('anchor'),
    /** When a landing touched its anchor, and which with what (`ISS-12: <path>`); null while it stands. */
    invalidAt: timestamp('invalid_at', { withTimezone: true }),
    invalidBy: text('invalid_by'),
    /**
     * The module it belongs to (ISS-1256): a module label of the same project, written only by the
     * placement door an agent calls (`labels/module-map-write.ts`); null where nobody placed it.
     */
    moduleId: uuid('module_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    numberUq: uniqueIndex('lessons_project_number_uq').on(t.projectId, t.number),
    anchorChk: check(
      'lessons_anchor_chk',
      sql`${t.anchor} IS NULL OR length(${t.anchor}) BETWEEN 3 AND 240`,
    ),
    invalidByChk: check(
      'lessons_invalid_by_chk',
      sql`(${t.invalidAt} IS NULL) = (${t.invalidBy} IS NULL)`,
    ),
    statusIdx: index('lessons_project_status_idx').on(t.projectId, t.status),
    numberChk: check('lessons_number_chk', sql`${t.number} >= 1`),
    sentenceChk: check('lessons_sentence_chk', sql`length(${t.sentence}) BETWEEN 1 AND 240`),
    scopeKindChk: check(
      'lessons_scope_kind_chk',
      sql`${t.scopeKind} IN (${inList(LESSON_SCOPE_KINDS)})`,
    ),
    itemKindChk: check(
      'lessons_scope_item_kind_chk',
      sql`${t.scopeItemKind} IS NULL OR ${t.scopeItemKind} IN (${inList(LESSON_ITEM_KINDS)})`,
    ),
    scopeChk: check(
      'lessons_scope_chk',
      sql`(${t.scopeKind} = 'area') = (${t.scopeAreaId} IS NOT NULL) AND (${t.scopeKind} = 'item_kind') = (${t.scopeItemKind} IS NOT NULL)`,
    ),
    aboutChk: check(
      'lessons_about_chk',
      sql`${t.about} IS NULL OR ${t.about} IN (${inList(LESSON_ABOUTS)})`,
    ),
    statusChk: check('lessons_status_chk', sql`${t.status} IN (${inList(LESSON_STATUSES)})`),
    agencyChk: check('lessons_agency_chk', sql`${t.proposedAgency} IN ('human', 'agent')`),
    approvedChk: check(
      'lessons_approved_chk',
      sql`${t.status} IN ('proposed', 'rejected') OR ${t.approvedAt} IS NOT NULL`,
    ),
    reasonChk: check(
      'lessons_decided_reason_chk',
      sql`${t.status} NOT IN ('rejected', 'retired') OR ${t.decidedReason} IS NOT NULL`,
    ),
    appliedChk: check('lessons_applied_chk', sql`${t.appliedCount} >= 0`),
    supersedesFk: foreignKey({
      columns: [t.supersedesId],
      foreignColumns: [t.id],
      name: 'lessons_supersedes_id_lessons_id_fk',
    }).onDelete('set null'),
    supersededByFk: foreignKey({
      columns: [t.supersededById],
      foreignColumns: [t.id],
      name: 'lessons_superseded_by_id_lessons_id_fk',
    }).onDelete('set null'),
  }),
);

// one correction (REQ-50 BC-1): a return, rejection or failing verdict said with a reason, or a chat
// or room reply the classifier read as one; one row per source event, so a retried delivery never doubles it
export const corrections = pgTable(
  'corrections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    source: text('source', { enum: CORRECTION_SOURCES }).notNull(),
    /** The source event's own id: the kernel move, the return, the verdict, the chat or room message. */
    sourceRef: text('source_ref').notNull(),
    itemKind: text('item_kind', { enum: CORRECTION_ITEM_KINDS }).notNull(),
    itemId: uuid('item_id').notNull(),
    itemKey: text('item_key').notNull(),
    itemTitle: text('item_title'),
    areaId: uuid('area_id').references(() => requirementAreas.id, { onDelete: 'set null' }),
    reason: text('reason').notNull(),
    byUserId: uuid('by_user_id').references(() => users.id, { onDelete: 'set null' }),
    agency: text('agency', { enum: actorAgencies }).notNull(),
    saidAt: timestamp('said_at', { withTimezone: true }).notNull().defaultNow(),
    lessonId: uuid('lesson_id').references(() => lessons.id, { onDelete: 'set null' }),
    linkedAt: timestamp('linked_at', { withTimezone: true }),
    score: real('score'),
    // the steward's finding that this is not a correction (REQ-50 BC-2): never linked or grouped again;
    // a row a person dismissed before 0522 keeps who and when, with a reason saying so
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
    rejectedBy: uuid('rejected_by').references(() => users.id, { onDelete: 'set null' }),
    rejectedReason: text('rejected_reason'),
  },
  (t) => ({
    sourceUq: uniqueIndex('corrections_source_ref_uq').on(t.source, t.sourceRef),
    projectIdx: index('corrections_project_said_idx').on(t.projectId, t.saidAt),
    lessonIdx: index('corrections_lesson_idx').on(t.lessonId),
    unlinkedIdx: index('corrections_unlinked_idx')
      .on(t.projectId)
      .where(sql`lesson_id IS NULL AND rejected_at IS NULL`),
    sourceChk: check('corrections_source_chk', sql`${t.source} IN (${inList(CORRECTION_SOURCES)})`),
    itemKindChk: check(
      'corrections_item_kind_chk',
      sql`${t.itemKind} IN (${inList(CORRECTION_ITEM_KINDS)})`,
    ),
    reasonChk: check('corrections_reason_chk', sql`length(btrim(${t.reason})) >= 1`),
    agencyChk: check('corrections_agency_chk', sql`${t.agency} IN ('human', 'agent')`),
    scoreChk: check(
      'corrections_score_chk',
      sql`(${t.source} IN ('chat', 'room')) = (${t.score} IS NOT NULL) AND (${t.score} IS NULL OR ${t.score} BETWEEN 0 AND 1)`,
    ),
    linkChk: check('corrections_link_chk', sql`(${t.lessonId} IS NULL) = (${t.linkedAt} IS NULL)`),
    rejectedChk: check(
      'corrections_rejected_chk',
      sql`(${t.rejectedAt} IS NULL) = (${t.rejectedReason} IS NULL) AND (${t.rejectedReason} IS NULL OR length(btrim(${t.rejectedReason})) >= 1)`,
    ),
  }),
);

// each output a lesson shaped (REQ-50 BC-4), as the output named it; a person may mark one wrongly
// applied, once, which raises a confusion about the lesson
export const lessonApplications = pgTable(
  'lesson_applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    lessonId: uuid('lesson_id')
      .notNull()
      .references(() => lessons.id, { onDelete: 'cascade' }),
    outputKind: text('output_kind', { enum: LESSON_OUTPUT_KINDS }).notNull(),
    outputRef: text('output_ref').notNull(),
    agentUserId: uuid('agent_user_id').references(() => users.id, { onDelete: 'set null' }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    wrongAt: timestamp('wrong_at', { withTimezone: true }),
    wrongBy: uuid('wrong_by').references(() => users.id, { onDelete: 'set null' }),
    wrongReason: text('wrong_reason'),
  },
  (t) => ({
    outputUq: uniqueIndex('lesson_applications_output_uq').on(
      t.lessonId,
      t.outputKind,
      t.outputRef,
    ),
    lessonIdx: index('lesson_applications_lesson_idx').on(t.lessonId, t.at),
    outputIdx: index('lesson_applications_ref_idx').on(t.projectId, t.outputKind, t.outputRef),
    kindChk: check(
      'lesson_applications_kind_chk',
      sql`${t.outputKind} IN (${inList(LESSON_OUTPUT_KINDS)})`,
    ),
    wrongChk: check(
      'lesson_applications_wrong_chk',
      sql`(${t.wrongAt} IS NULL) = (${t.wrongReason} IS NULL)`,
    ),
  }),
);

// an agent stopped guessing about a lesson (REQ-50 BC-5): both sides and the resolution it
// recommends; raising one holds the lesson, and the steward's settlement ends it, with its reason
export const lessonConfusions = pgTable(
  'lesson_confusions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    lessonId: uuid('lesson_id')
      .notNull()
      .references(() => lessons.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: LESSON_CONFUSION_KINDS }).notNull(),
    otherLessonId: uuid('other_lesson_id').references(() => lessons.id, { onDelete: 'set null' }),
    otherRef: text('other_ref'),
    sideLesson: text('side_lesson').notNull(),
    sideOther: text('side_other').notNull(),
    recommended: text('recommended', { enum: LESSON_RESOLUTIONS }).notNull(),
    recommendedSentence: text('recommended_sentence'),
    applicationId: uuid('application_id').references(() => lessonApplications.id, {
      onDelete: 'set null',
    }),
    raisedBy: uuid('raised_by').references(() => users.id, { onDelete: 'set null' }),
    raisedAgency: text('raised_agency', { enum: actorAgencies }).notNull(),
    raisedAt: timestamp('raised_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    resolution: text('resolution', { enum: LESSON_RESOLUTIONS }),
    /** Why the steward kept, edited or retired the lesson; null on a confusion settled before 0522. */
    reason: text('reason'),
    /** When the steward last tried it and left it waiting, so a pass reaches the least recently tried first. */
    triedAt: timestamp('tried_at', { withTimezone: true }),
  },
  (t) => ({
    openIdx: index('lesson_confusions_open_idx')
      .on(t.projectId, t.raisedAt)
      .where(sql`decided_at IS NULL`),
    lessonIdx: index('lesson_confusions_lesson_idx').on(t.lessonId),
    kindChk: check(
      'lesson_confusions_kind_chk',
      sql`${t.kind} IN (${inList(LESSON_CONFUSION_KINDS)})`,
    ),
    recommendedChk: check(
      'lesson_confusions_recommended_chk',
      sql`${t.recommended} IN (${inList(LESSON_RESOLUTIONS)}) AND (${t.recommended} <> 'edit' OR ${t.recommendedSentence} IS NOT NULL)`,
    ),
    decidedChk: check(
      'lesson_confusions_decided_chk',
      sql`(${t.decidedAt} IS NULL) = (${t.resolution} IS NULL) AND (${t.resolution} IS NULL OR ${t.resolution} IN (${inList(LESSON_RESOLUTIONS)}))`,
    ),
    agencyChk: check('lesson_confusions_agency_chk', sql`${t.raisedAgency} IN ('human', 'agent')`),
  }),
);

// A capability card's freshness (0667, ISS-1251 §5, §7). Cards are Forge's own and live in code beside
// their doors, so these rows are keyed by the card's id and belong to no project:
//  - a card owed a re-check since a landing touched what it describes, until the re-check clears it;
//  - the last replay of each of its scenarios, by name;
//  - each delta a lesson that held folded into it, proposed until the card's code carries it.
export const cardRechecks = pgTable('card_rechecks', {
  cardId: text('card_id').primaryKey(),
  owedSince: timestamp('owed_since', { withTimezone: true }).notNull().defaultNow(),
  /** What touched it: `ISS-12 changed <path>`, newest first when touched again. */
  owedBy: text('owed_by').notNull(),
});

export const cardScenarioRuns = pgTable(
  'card_scenario_runs',
  {
    cardId: text('card_id').notNull(),
    scenario: text('scenario').notNull(),
    passed: integer('passed').notNull(),
    /** The change it was replayed for: `L-12 fold`, `L-12 edit`. */
    change: text('change').notNull(),
    reason: text('reason').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: uniqueIndex('card_scenario_runs_card_scenario_uq').on(t.cardId, t.scenario),
    passedChk: check('card_scenario_runs_passed_chk', sql`${t.passed} IN (0, 1)`),
  }),
);

export const CARD_DELTA_FIELDS = ['situation', 'bestPractice', 'redFlag'] as const;
export const CARD_DELTA_STATUSES = ['proposed', 'applied', 'dropped'] as const;

export const cardDeltas = pgTable(
  'card_deltas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cardId: text('card_id').notNull(),
    field: text('field', { enum: CARD_DELTA_FIELDS }).notNull(),
    op: text('op', { enum: ['add', 'update'] }).notNull(),
    text: text('text').notNull(),
    replaces: text('replaces'),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    /** The lesson folded: `L-12`. */
    fromLesson: text('from_lesson').notNull(),
    status: text('status', { enum: CARD_DELTA_STATUSES }).notNull().default('proposed'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    cardIdx: index('card_deltas_card_idx').on(t.cardId, t.status),
    fieldChk: check('card_deltas_field_chk', sql`${t.field} IN (${inList(CARD_DELTA_FIELDS)})`),
    opChk: check('card_deltas_op_chk', sql`${t.op} IN ('add', 'update')`),
    statusChk: check(
      'card_deltas_status_chk',
      sql`${t.status} IN (${inList(CARD_DELTA_STATUSES)})`,
    ),
    replacesChk: check(
      'card_deltas_replaces_chk',
      sql`(${t.op} = 'update') = (${t.replaces} IS NOT NULL)`,
    ),
  }),
);
