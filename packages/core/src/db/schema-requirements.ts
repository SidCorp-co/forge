import { PICTURE_KINDS, REQUIREMENT_KINDS } from '@forge/contracts/requirement-pictures';
import {
  BASELINE_ACTS,
  type BaselineReadiness,
  REQUIREMENT_STATUSES,
  REVISION_STATES,
} from '@forge/contracts/requirements';
import { REQUIREMENT_CRITERION_FORMS } from '@forge/contracts/suggestions';
import { WRITTEN_LANGS } from '@forge/contracts/written-lang';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { contractVersions } from './schema-ecosystem.js';
import { mockups } from './schema-mockups.js';
import { projects } from './schema-projects.js';
import { suggestions } from './schema-suggestions.js';
import { actorAgencies } from './schema-vocabulary.js';
import { projectWorkflowDesigns, projectWorkflows } from './schema-workflows.js';

export { REQUIREMENT_STATUSES, type RequirementStatus } from '@forge/contracts/requirements';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

export { REVISION_STATES, type RevisionState } from '@forge/contracts/requirements';

export const CRITERION_FORMS = REQUIREMENT_CRITERION_FORMS;
export type CriterionForm = (typeof CRITERION_FORMS)[number];

// the stored status holds only what a person decides (workflow requirement-lifecycle);
// in_delivery and delivered are read-time phases (`requirements/standing.ts:deliveryOf`), never written (Q1)
/** A project's list of business areas (REQ-29 BC-1): the rows the Requirements list groups and filters by. */
export const requirementAreas = pgTable(
  'requirement_areas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    nameUq: uniqueIndex('requirement_areas_project_name_uq').on(t.projectId, t.name),
    nameChk: check('requirement_areas_name_chk', sql`length(${t.name}) BETWEEN 1 AND 60`),
  }),
);

export const requirements = pgTable(
  'requirements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    reqSeq: integer('req_seq').notNull(),
    title: text('title').notNull(),
    status: text('status', { enum: REQUIREMENT_STATUSES }).notNull().default('draft'),
    // the head is the current revision only: a draft or proposed revision is never the head
    currentRevision: integer('current_revision'),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    // A contract request from another project (E2, 0410): that project and the contract it asks for;
    // only this project agrees it
    requestedByProjectId: uuid('requested_by_project_id').references(() => projects.id, {
      onDelete: 'set null',
    }),
    requestedContractSlug: text('requested_contract_slug'),
    // REQ-29: one business area and a short name of at most six words; null until a person sets them,
    // the assistant's proposal waits beside them until a person accepts it
    areaId: uuid('area_id').references((): AnyPgColumn => requirementAreas.id, {
      onDelete: 'set null',
    }),
    shortName: text('short_name'),
    proposedAreaId: uuid('proposed_area_id').references((): AnyPgColumn => requirementAreas.id, {
      onDelete: 'set null',
    }),
    proposedShortName: text('proposed_short_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    seqUq: uniqueIndex('requirements_project_seq_uq').on(t.projectId, t.reqSeq),
    statusIdx: index('requirements_project_status_idx').on(t.projectId, t.status),
    statusChk: check(
      'requirements_status_chk',
      sql`${t.status} IN (${inList(REQUIREMENT_STATUSES)})`,
    ),
    seqChk: check('requirements_seq_chk', sql`${t.reqSeq} >= 1`),
    requestChk: check(
      'requirements_request_chk',
      sql`${t.requestedContractSlug} IS NULL OR (${t.requestedByProjectId} IS NOT NULL AND length(${t.requestedContractSlug}) BETWEEN 1 AND 120)`,
    ),
    shortNameChk: check(
      'requirements_short_name_chk',
      sql`(${t.shortName} IS NULL OR length(${t.shortName}) BETWEEN 1 AND 80) AND (${t.proposedShortName} IS NULL OR length(${t.proposedShortName}) BETWEEN 1 AND 80)`,
    ),
    requestSelfChk: check(
      'requirements_request_self_chk',
      sql`${t.requestedByProjectId} IS DISTINCT FROM ${t.projectId}`,
    ),
    headFk: foreignKey({
      name: 'requirements_head_fk',
      columns: [t.id, t.currentRevision],
      foreignColumns: [requirementRevisions.requirementId, requirementRevisions.revision],
    }),
    agreedHeadChk: check(
      'requirements_agreed_head_chk',
      sql`${t.status} NOT IN ('agreed', 'accepted') OR ${t.currentRevision} IS NOT NULL`,
    ),
  }),
);

// insert-only evidence: content is written while a revision is a draft and frozen once it is
// proposed; the trigger in migration 0349 refuses anything else as REVISION_IMMUTABLE
export const requirementRevisions = pgTable(
  'requirement_revisions',
  {
    requirementId: uuid('requirement_id')
      .notNull()
      .references((): AnyPgColumn => requirements.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    state: text('state', { enum: REVISION_STATES }).notNull().default('draft'),
    baseRevision: integer('base_revision'),
    spec: jsonb('spec').notNull(),
    specVersion: integer('spec_version').notNull().default(1),
    tldr: text('tldr'),
    changeSummary: text('change_summary'),
    reason: text('reason').notNull(),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    authorAgency: text('author_agency', { enum: actorAgencies }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    proposedAt: timestamp('proposed_at', { withTimezone: true }),
    proposedBy: uuid('proposed_by').references(() => users.id, { onDelete: 'restrict' }),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'restrict' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    returnReason: text('return_reason'),
    // the accepting signer's own words, kept on the act itself; the reason column above is
    // the author's, and a re-baseline copies this one, never that one (ISS-84)
    acceptReason: text('accept_reason'),
    // a draft withdrawn without being proposed (REQ-41 BC-12, migration 0481): why, by whom, when
    withdrawnReason: text('withdrawn_reason'),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    withdrawnBy: uuid('withdrawn_by').references(() => users.id, { onDelete: 'restrict' }),
    // an accepted suggestion's effect points back at it (suggestion-lifecycle step accepted)
    fromSuggestionId: uuid('from_suggestion_id').references((): AnyPgColumn => suggestions.id, {
      onDelete: 'no action',
    }),
    /** The language the text was written in (`@forge/contracts/written-lang`); null where it was written before the language was stored. */
    writtenLang: text('written_lang', { enum: WRITTEN_LANGS }),
    // what the requirement is and its one picture (REQ-35, Requirement lifecycle r14): neither is
    // frozen with the text (`requirement_revision_guard()` reads neither), since the author corrects
    // the kind and anyone who may edit replaces the picture, and nothing gates on either
    kind: text('kind', { enum: REQUIREMENT_KINDS }),
    pictureId: uuid('picture_id').references((): AnyPgColumn => requirementPictures.id),
  },
  (t) => ({
    kindChk: check(
      'requirement_revisions_kind_chk',
      sql`${t.kind} IS NULL OR ${t.kind} IN (${inList(REQUIREMENT_KINDS)})`,
    ),
    writtenLangChk: check(
      'requirement_revisions_written_lang_chk',
      sql`${t.writtenLang} IS NULL OR ${t.writtenLang} IN ('en', 'vi')`,
    ),
    pk: primaryKey({ columns: [t.requirementId, t.revision] }),
    oneCurrentUq: uniqueIndex('requirement_revisions_one_current_uq')
      .on(t.requirementId)
      .where(sql`state = 'current'`),
    oneOpenUq: uniqueIndex('requirement_revisions_one_open_uq')
      .on(t.requirementId)
      .where(sql`state IN ('draft', 'proposed')`),
    stateChk: check(
      'requirement_revisions_state_chk',
      sql`${t.state} IN ('draft', 'proposed', 'current', 'superseded', 'withdrawn')`,
    ),
    withdrawnChk: check(
      'requirement_revisions_withdrawn_chk',
      sql`${t.state} <> 'withdrawn' OR (${t.withdrawnReason} ~ '[^[:space:]]' AND ${t.withdrawnAt} IS NOT NULL AND ${t.withdrawnBy} IS NOT NULL)`,
    ),
    revisionChk: check('requirement_revisions_revision_chk', sql`${t.revision} >= 1`),
    authorAgencyChk: check(
      'requirement_revisions_author_agency_chk',
      sql`${t.authorAgency} IN (${inList(actorAgencies)})`,
    ),
    reasonChk: check('requirement_revisions_reason_chk', sql`${t.reason} ~ '[^[:space:]]'`),
    decidedChk: check(
      'requirement_revisions_decided_chk',
      sql`${t.state} NOT IN ('current', 'superseded') OR (${t.decidedBy} IS NOT NULL AND ${t.decidedAt} IS NOT NULL)`,
    ),
    baseChk: check(
      'requirement_revisions_base_chk',
      sql`${t.baseRevision} IS NULL OR ${t.baseRevision} < ${t.revision}`,
    ),
  }),
);

// a BC code is stable across revisions; a row is one wording of it, live from since_revision
// until retired_revision, so the criteria of revision n are the rows whose interval holds n
export const requirementCriteria = pgTable(
  'requirement_criteria',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requirementId: uuid('requirement_id')
      .notNull()
      .references((): AnyPgColumn => requirements.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    body: text('body').notNull(),
    form: text('form', { enum: CRITERION_FORMS }).notNull().default('statement'),
    sinceRevision: integer('since_revision').notNull(),
    retiredRevision: integer('retired_revision'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sinceFk: foreignKey({
      name: 'requirement_criteria_since_fk',
      columns: [t.requirementId, t.sinceRevision],
      foreignColumns: [requirementRevisions.requirementId, requirementRevisions.revision],
    }).onDelete('cascade'),
    liveCodeUq: uniqueIndex('requirement_criteria_live_code_uq')
      .on(t.requirementId, t.code)
      .where(sql`retired_revision IS NULL`),
    wordingUq: uniqueIndex('requirement_criteria_wording_uq').on(
      t.requirementId,
      t.code,
      t.sinceRevision,
    ),
    codeChk: check('requirement_criteria_code_chk', sql`${t.code} ~ '^BC-[1-9][0-9]*$'`),
    formChk: check('requirement_criteria_form_chk', sql`${t.form} IN ('statement', 'scenario')`),
    bodyChk: check('requirement_criteria_body_chk', sql`${t.body} ~ '[^[:space:]]'`),
    retiredChk: check(
      'requirement_criteria_retired_chk',
      sql`${t.retiredRevision} IS NULL OR ${t.retiredRevision} > ${t.sinceRevision}`,
    ),
  }),
);

// The steps and edges of one linked design a business criterion constrains (REQ-17 BC-10), keyed by
// the BC code so a reworded criterion keeps its trace; a row is one step, or one edge by its ends and
// its label where several edges share both ends
export const requirementCriterionSteps = pgTable(
  'requirement_criterion_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    requirementId: uuid('requirement_id')
      .notNull()
      .references((): AnyPgColumn => requirements.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => projectWorkflows.id, { onDelete: 'cascade' }),
    stepId: text('step_id'),
    edgeFrom: text('edge_from'),
    edgeTo: text('edge_to'),
    edgeLabel: text('edge_label'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workflowIdx: index('requirement_criterion_steps_workflow_idx').on(t.projectId, t.workflowId),
    criterionIdx: index('requirement_criterion_steps_criterion_idx').on(t.requirementId, t.code),
    nodeUq: uniqueIndex('requirement_criterion_steps_node_uq').on(
      t.requirementId,
      t.code,
      t.workflowId,
      sql`coalesce(${t.stepId}, '')`,
      sql`coalesce(${t.edgeFrom}, '')`,
      sql`coalesce(${t.edgeTo}, '')`,
      sql`coalesce(${t.edgeLabel}, '')`,
    ),
    codeChk: check('requirement_criterion_steps_code_chk', sql`${t.code} ~ '^BC-[1-9][0-9]*$'`),
    nodeChk: check(
      'requirement_criterion_steps_node_chk',
      sql`(${t.stepId} IS NOT NULL AND ${t.edgeFrom} IS NULL AND ${t.edgeTo} IS NULL AND ${t.edgeLabel} IS NULL) OR (${t.stepId} IS NULL AND ${t.edgeFrom} IS NOT NULL AND ${t.edgeTo} IS NOT NULL)`,
    ),
  }),
);

// a requirement has its designs before it has issues, so the link cannot be read off workflow_builds
export const requirementWorkflows = pgTable(
  'requirement_workflows',
  {
    requirementId: uuid('requirement_id')
      .notNull()
      .references((): AnyPgColumn => requirements.id, { onDelete: 'cascade' }),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => projectWorkflows.id, { onDelete: 'cascade' }),
    linkedBy: uuid('linked_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.requirementId, t.workflowId] }),
    workflowIdx: index('requirement_workflows_workflow_idx').on(t.workflowId),
  }),
);

// A requirement names the contracts it is built on before any version exists (contract-first), so
// the link is to the contract, and the agree or re-pin pins whichever version is current then.
export const requirementContracts = pgTable(
  'requirement_contracts',
  {
    requirementId: uuid('requirement_id')
      .notNull()
      .references((): AnyPgColumn => requirements.id, { onDelete: 'cascade' }),
    providerProjectId: uuid('provider_project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    contractSlug: text('contract_slug').notNull(),
    linkedBy: uuid('linked_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.requirementId, t.providerProjectId, t.contractSlug] }),
    contractIdx: index('requirement_contracts_contract_idx').on(
      t.providerProjectId,
      t.contractSlug,
    ),
  }),
);

// the agree is a row, not a column: re-agreeing writes a new baseline and the earlier one
// stays, so "what was agreed at r4" is a read after r5 is agreed; a re-pin onto newly approved
// designs is a further row at the same revision (seq 2, 3, …), so the latest is the highest
// (revision, seq) and an earlier pin set stays readable (ISS-86)
export const requirementBaselines = pgTable(
  'requirement_baselines',
  {
    requirementId: uuid('requirement_id').notNull(),
    revision: integer('revision').notNull(),
    seq: integer('seq').notNull().default(1),
    act: text('act', { enum: BASELINE_ACTS }).notNull().default('agree'),
    // a person names their user; the kernel's follow of a pin-only design names none (REQ-41 BC-23)
    agreedBy: uuid('agreed_by').references(() => users.id, { onDelete: 'restrict' }),
    agreedKind: text('agreed_kind', { enum: ['person', 'kernel'] })
      .notNull()
      .default('person'),
    agreedAt: timestamp('agreed_at', { withTimezone: true }).notNull().defaultNow(),
    reason: text('reason'),
    readiness: jsonb('readiness').$type<BaselineReadiness>(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.requirementId, t.revision, t.seq] }),
    seqChk: check('requirement_baselines_seq_chk', sql`${t.seq} >= 1`),
    agreedKindChk: check(
      'requirement_baselines_agreed_kind_chk',
      sql`(${t.agreedKind} = 'person' AND ${t.agreedBy} IS NOT NULL) OR (${t.agreedKind} = 'kernel' AND ${t.agreedBy} IS NULL AND ${t.act} = 'repin')`,
    ),
    actChk: check(
      'requirement_baselines_act_chk',
      sql`${t.act} IN (${inList(BASELINE_ACTS)}) AND (${t.act} = 'agree') = (${t.seq} = 1)`,
    ),
    revisionFk: foreignKey({
      name: 'requirement_baselines_revision_fk',
      columns: [t.requirementId, t.revision],
      foreignColumns: [requirementRevisions.requirementId, requirementRevisions.revision],
    }).onDelete('cascade'),
  }),
);

// every picture written for a revision, insert-only (`requirement_picture_guard()`): the revision
// points at the one it shows, and a replaced or uncarried one stays here as the requirement's
// history with who drew it and when (Requirement lifecycle r14 `picture_shown`)
export const requirementPictures = pgTable(
  'requirement_pictures',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requirementId: uuid('requirement_id').notNull(),
    drawnFor: integer('drawn_for').notNull(),
    kind: text('kind', { enum: PICTURE_KINDS }).notNull(),
    content: jsonb('content').notNull(),
    alt: text('alt').notNull(),
    writtenBy: uuid('written_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    writtenAgency: text('written_agency', { enum: actorAgencies }).notNull(),
    writtenAt: timestamp('written_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    revisionFk: foreignKey({
      name: 'requirement_pictures_revision_fk',
      columns: [t.requirementId, t.drawnFor],
      foreignColumns: [requirementRevisions.requirementId, requirementRevisions.revision],
    }).onDelete('cascade'),
    kindChk: check('requirement_pictures_kind_chk', sql`${t.kind} IN (${inList(PICTURE_KINDS)})`),
    altChk: check('requirement_pictures_alt_chk', sql`${t.alt} ~ '[^[:space:]]'`),
    agencyChk: check(
      'requirement_pictures_agency_chk',
      sql`${t.writtenAgency} IN (${inList(actorAgencies)})`,
    ),
    requirementIdx: index('requirement_pictures_requirement_idx').on(t.requirementId, t.writtenAt),
  }),
);

// one pin per linked design revision or contract version at the agree: an exclusive arc over
// two composite keys, each a real foreign key, so a pinned revision or version cannot be deleted
export const requirementBaselinePins = pgTable(
  'requirement_baseline_pins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requirementId: uuid('requirement_id').notNull(),
    revision: integer('revision').notNull(),
    baselineSeq: integer('baseline_seq').notNull().default(1),
    workflowId: uuid('workflow_id'),
    designRevision: integer('design_revision'),
    providerProjectId: uuid('provider_project_id'),
    contractSlug: text('contract_slug'),
    contractVersion: text('contract_version'),
    // an accepted mockup was pinned beside the designs (ISS-78) until REQ-35: the pins already
    // written stay as what those baselines agreed, and `requirement_baseline_pin_guard()` refuses a new one
    mockupId: uuid('mockup_id').references((): AnyPgColumn => mockups.id, {
      onDelete: 'no action',
    }),
  },
  (t) => ({
    baselineFk: foreignKey({
      name: 'requirement_baseline_pins_baseline_fk',
      columns: [t.requirementId, t.revision, t.baselineSeq],
      foreignColumns: [
        requirementBaselines.requirementId,
        requirementBaselines.revision,
        requirementBaselines.seq,
      ],
    }).onDelete('cascade'),
    designFk: foreignKey({
      name: 'requirement_baseline_pins_design_fk',
      columns: [t.workflowId, t.designRevision],
      foreignColumns: [projectWorkflowDesigns.workflowId, projectWorkflowDesigns.revision],
    }),
    contractFk: foreignKey({
      name: 'requirement_baseline_pins_contract_fk',
      columns: [t.providerProjectId, t.contractSlug, t.contractVersion],
      foreignColumns: [
        contractVersions.providerProjectId,
        contractVersions.contractSlug,
        contractVersions.version,
      ],
    }),
    baselineIdx: index('requirement_baseline_pins_baseline_idx').on(
      t.requirementId,
      t.revision,
      t.baselineSeq,
    ),
    arcChk: check(
      'requirement_baseline_pins_arc_chk',
      sql`(num_nonnulls(${t.workflowId}, ${t.designRevision}) = 2 AND num_nonnulls(${t.providerProjectId}, ${t.contractSlug}, ${t.contractVersion}, ${t.mockupId}) = 0) OR (num_nonnulls(${t.workflowId}, ${t.designRevision}, ${t.mockupId}) = 0 AND num_nonnulls(${t.providerProjectId}, ${t.contractSlug}, ${t.contractVersion}) = 3) OR (num_nonnulls(${t.workflowId}, ${t.designRevision}, ${t.providerProjectId}, ${t.contractSlug}, ${t.contractVersion}) = 0 AND ${t.mockupId} IS NOT NULL)`,
    ),
  }),
);
