import {
  FEEDBACK_ATTACHMENT_LABELS,
  FEEDBACK_CONFIRM_WAIT_ON,
  FEEDBACK_DECISIONS,
  FEEDBACK_KINDS,
  FEEDBACK_MESSAGE_AUDIENCES,
  FEEDBACK_ROUTES,
  FEEDBACK_SEVERITIES,
  FEEDBACK_STATUSES,
} from '@forge/contracts/feedback';
import { WRITTEN_LANGS } from '@forge/contracts/written-lang';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
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
import { issues } from './schema-issues.js';
import { mockups } from './schema-mockups.js';
import { pipelineRuns } from './schema-pipeline.js';
import { projects } from './schema-projects.js';
import { requirementCriteria, requirements } from './schema-requirements.js';
import { suggestions } from './schema-suggestions.js';
import { projectWorkflows } from './schema-workflows.js';

export {
  FEEDBACK_DECISIONS,
  FEEDBACK_KINDS,
  FEEDBACK_ROUTES,
  FEEDBACK_SEVERITIES,
  FEEDBACK_STATUSES,
} from '@forge/contracts/feedback';

/** The room message that ended a confirm wait, as `confirm_wait_met_by` keeps it (ISS-1038). */
export interface ConfirmWaitMetBy {
  message: string;
  rid: string;
  thread: string;
  author: string;
  at: string;
  text: string;
}

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

// FB-n (workflow feedback-lifecycle rev 2): the stored status is only what a person decided;
// planned and resolved are read from the linked work (Q1). A keyed row is never deleted: a
// redaction (UC15) empties its text and keeps the row so every link to it still resolves
export const feedback = pgTable(
  'feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    fbSeq: integer('fb_seq').notNull(),
    kind: text('kind', { enum: FEEDBACK_KINDS }).notNull(),
    severity: text('severity', { enum: FEEDBACK_SEVERITIES }).notNull().default('medium'),
    title: text('title').notNull(),
    body: text('body'),
    /** Where it was seen; with no target key it is the screen the item is about. */
    whereSeen: text('where_seen'),
    // an exclusive arc of real foreign keys; `no action` so a target is never deleted out
    // from under a keyed row, while a project's cascade still removes both
    requirementId: uuid('requirement_id').references((): AnyPgColumn => requirements.id, {
      onDelete: 'no action',
    }),
    issueId: uuid('issue_id').references((): AnyPgColumn => issues.id, { onDelete: 'no action' }),
    /**
     * The business criterion its triage named it violates (Feedback lifecycle r14 triage-check), null
     * where the triage answered none or none has run. Loop close reads that criterion's verdict.
     */
    violatedCriterionId: uuid('violated_criterion_id').references(
      (): AnyPgColumn => requirementCriteria.id,
      { onDelete: 'set null' },
    ),
    releaseRunId: uuid('release_run_id').references((): AnyPgColumn => pipelineRuns.id, {
      onDelete: 'no action',
    }),
    workflowId: uuid('workflow_id').references((): AnyPgColumn => projectWorkflows.id, {
      onDelete: 'no action',
    }),
    /** On a workflow target, the one step or edge of it the item is about; none keeps it workflow-level. */
    stepId: text('step_id'),
    edgeFrom: text('edge_from'),
    edgeTo: text('edge_to'),
    edgeLabel: text('edge_label'),
    // the fifth arc member is a provider's contract version, filed by core alone (E3); its
    // deadline is that version's approval plus the provider's commitment window
    contractProviderProjectId: uuid('contract_provider_project_id').references(() => projects.id, {
      onDelete: 'cascade',
    }),
    contractSlug: text('contract_slug'),
    contractVersion: text('contract_version'),
    // the sixth is a route or tool this project serves (ISS-279): an element of a version of an
    // openapi or mcp-tools contract it provides, named as it read when filed
    endpointContractSlug: text('endpoint_contract_slug'),
    endpointContractVersion: text('endpoint_contract_version'),
    endpointElement: text('endpoint_element'),
    // the seventh is a mockup (REQ-49 BC-4): an item about one proposed screen or call
    mockupId: uuid('mockup_id').references((): AnyPgColumn => mockups.id, {
      onDelete: 'no action',
    }),
    dueAt: timestamp('due_at', { withTimezone: true }),
    /** Parked out of New until then, with the reason a triager reads on return; only while new or reopened. */
    snoozedUntil: timestamp('snoozed_until', { withTimezone: true }),
    snoozeReason: text('snooze_reason'),
    /** When a sweep first read the item resolved: the verify window counts from it; cleared when it stops reading resolved. */
    resolvedSeenAt: timestamp('resolved_seen_at', { withTimezone: true }),
    /**
     * Past its window, the record could not say the problem is gone (`loop-close.ts:goneByRecord`):
     * when a sweep found that, and why. It counts only while it is no older than `resolvedSeenAt`.
     */
    verifyHeldAt: timestamp('verify_held_at', { withTimezone: true }),
    verifyHeldWhy: text('verify_held_why'),
    /**
     * A shipped agent-reported item's confirm waits (ISS-902): out of its master's owed line until
     * `until`, or until `on` happens first (`confirmWaitMetAt`), for the reason a person reads on it.
     * Set by the reporter or its master (`confirm-wait.ts`); cleared by the verify or reopen it waits for.
     */
    confirmWaitUntil: timestamp('confirm_wait_until', { withTimezone: true }),
    confirmWaitOn: text('confirm_wait_on', { enum: FEEDBACK_CONFIRM_WAIT_ON }),
    confirmWaitReason: text('confirm_wait_reason'),
    confirmWaitSetAt: timestamp('confirm_wait_set_at', { withTimezone: true }),
    confirmWaitSetBy: uuid('confirm_wait_set_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    /**
     * With `confirmWaitOn` room_message, the chat group and thread whose next member message ends the
     * wait (ISS-1038): the ones the wait named, else the thread the item was recorded from. Null on a
     * wait set before they were kept on an item no thread is known for, which only its date ends.
     */
    confirmWaitRid: text('confirm_wait_rid'),
    confirmWaitThread: text('confirm_wait_thread'),
    /** When the event `confirmWaitOn` names happened, which ends the wait before its date. */
    confirmWaitMetAt: timestamp('confirm_wait_met_at', { withTimezone: true }),
    /**
     * The room message that ended it (ISS-1038): its id, group, thread, author, time and words, the
     * words stored as the item's project's data policy keeps text.
     */
    confirmWaitMetBy: jsonb('confirm_wait_met_by').$type<ConfirmWaitMetBy>(),
    status: text('status', { enum: FEEDBACK_STATUSES }).notNull().default('new'),
    route: text('route', { enum: FEEDBACK_ROUTES }),
    // an issue route's carriers are rows of `feedback_route_issues`, one or more (ISS-265)
    routedRequirementId: uuid('routed_requirement_id').references(
      (): AnyPgColumn => requirements.id,
      { onDelete: 'no action' },
    ),
    routedSuggestionId: uuid('routed_suggestion_id').references((): AnyPgColumn => suggestions.id, {
      onDelete: 'no action',
    }),
    duplicateOf: uuid('duplicate_of').references((): AnyPgColumn => feedback.id, {
      onDelete: 'no action',
    }),
    answer: text('answer'),
    reportedBy: uuid('reported_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    reporterAgency: text('reporter_agency', { enum: ['human', 'agent'] }).notNull(),
    /** The project's data policy scrubbed title and body on write; `redactions` counts what it replaced. */
    scrubbed: boolean('scrubbed').notNull().default(false),
    redactions: integer('redactions').notNull().default(0),
    redactedAt: timestamp('redacted_at', { withTimezone: true }),
    redactedBy: uuid('redacted_by').references(() => users.id, { onDelete: 'restrict' }),
    // one item per consumer per breaking contract version (E3), held by a unique key the filer
    // names, so a retried approval cannot file a twin
    dedupKey: text('dedup_key'),
    /**
     * What a report through the Forge door is about, said the same way by everyone who meets it
     * (REQ-47 BC-5): a later report naming it while the item is open is an occurrence of this item.
     */
    signalKey: text('signal_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** The language the text was written in (`@forge/contracts/written-lang`); null where it was written before the language was stored. */
    writtenLang: text('written_lang', { enum: WRITTEN_LANGS }),
  },
  (t) => ({
    writtenLangChk: check(
      'feedback_written_lang_chk',
      sql`${t.writtenLang} IS NULL OR ${t.writtenLang} IN ('en', 'vi')`,
    ),
    arcChk: check(
      'feedback_arc_chk',
      sql`num_nonnulls(${t.requirementId}, ${t.issueId}, ${t.releaseRunId}, ${t.workflowId}, ${t.contractVersion}, ${t.endpointElement}, ${t.mockupId}) = 1 OR (num_nonnulls(${t.requirementId}, ${t.issueId}, ${t.releaseRunId}, ${t.workflowId}, ${t.contractVersion}, ${t.endpointElement}, ${t.mockupId}) = 0 AND ${t.whereSeen} IS NOT NULL)`,
    ),
    nodeChk: check(
      'feedback_node_chk',
      sql`(${t.stepId} IS NULL AND ${t.edgeFrom} IS NULL AND ${t.edgeTo} IS NULL AND ${t.edgeLabel} IS NULL) OR (${t.workflowId} IS NOT NULL AND ((${t.stepId} IS NOT NULL AND ${t.edgeFrom} IS NULL AND ${t.edgeTo} IS NULL AND ${t.edgeLabel} IS NULL) OR (${t.stepId} IS NULL AND ${t.edgeFrom} IS NOT NULL AND ${t.edgeTo} IS NOT NULL)))`,
    ),
    contractTargetChk: check(
      'feedback_contract_target_chk',
      sql`num_nonnulls(${t.contractProviderProjectId}, ${t.contractSlug}, ${t.contractVersion}) IN (0, 3)`,
    ),
    endpointTargetChk: check(
      'feedback_endpoint_target_chk',
      sql`num_nonnulls(${t.endpointContractSlug}, ${t.endpointContractVersion}, ${t.endpointElement}) IN (0, 3)`,
    ),
    endpointFk: foreignKey({
      name: 'feedback_endpoint_contract_version_fk',
      columns: [t.projectId, t.endpointContractSlug, t.endpointContractVersion],
      foreignColumns: [
        contractVersions.providerProjectId,
        contractVersions.contractSlug,
        contractVersions.version,
      ],
    }),
    dueChk: check('feedback_due_chk', sql`${t.dueAt} IS NULL OR ${t.contractVersion} IS NOT NULL`),
    verifyHeldChk: check(
      'feedback_verify_held_chk',
      sql`(${t.verifyHeldAt} IS NULL) = (${t.verifyHeldWhy} IS NULL)`,
    ),
    confirmWaitRoomChk: check(
      'feedback_confirm_wait_room_chk',
      sql`(${t.confirmWaitRid} IS NULL) = (${t.confirmWaitThread} IS NULL) AND (${t.confirmWaitRid} IS NULL OR ${t.confirmWaitOn} = 'room_message') AND (${t.confirmWaitMetBy} IS NULL OR ${t.confirmWaitMetAt} IS NOT NULL)`,
    ),
    confirmWaitChk: check(
      'feedback_confirm_wait_chk',
      sql`(${t.confirmWaitUntil} IS NULL) = (${t.confirmWaitReason} IS NULL) AND (${t.confirmWaitUntil} IS NULL) = (${t.confirmWaitSetAt} IS NULL) AND (${t.confirmWaitReason} IS NULL OR ${t.confirmWaitReason} ~ '[^[:space:]]') AND (${t.confirmWaitOn} IS NULL OR (${t.confirmWaitUntil} IS NOT NULL AND ${t.confirmWaitOn} IN (${inList(FEEDBACK_CONFIRM_WAIT_ON)}))) AND (${t.confirmWaitMetAt} IS NULL OR ${t.confirmWaitOn} IS NOT NULL)`,
    ),
    contractFk: foreignKey({
      name: 'feedback_contract_version_fk',
      columns: [t.contractProviderProjectId, t.contractSlug, t.contractVersion],
      foreignColumns: [
        contractVersions.providerProjectId,
        contractVersions.contractSlug,
        contractVersions.version,
      ],
    }),
    kindChk: check('feedback_kind_chk', sql`${t.kind} IN (${inList(FEEDBACK_KINDS)})`),
    severityChk: check(
      'feedback_severity_chk',
      sql`${t.severity} IN (${inList(FEEDBACK_SEVERITIES)})`,
    ),
    statusChk: check('feedback_status_chk', sql`${t.status} IN (${inList(FEEDBACK_STATUSES)})`),
    routeChk: check(
      'feedback_route_chk',
      sql`(${t.route} IS NULL AND num_nonnulls(${t.routedRequirementId}, ${t.routedSuggestionId}, ${t.duplicateOf}, ${t.answer}) = 0)
        OR (${t.route} = 'issue' AND num_nonnulls(${t.routedRequirementId}, ${t.routedSuggestionId}, ${t.duplicateOf}, ${t.answer}) = 0)
        OR (${t.route} = 'revision' AND ${t.routedSuggestionId} IS NOT NULL AND num_nonnulls(${t.routedRequirementId}, ${t.duplicateOf}, ${t.answer}) = 0)
        OR (${t.route} = 'new_requirement' AND ${t.routedRequirementId} IS NOT NULL AND num_nonnulls(${t.routedSuggestionId}, ${t.duplicateOf}, ${t.answer}) = 0)
        OR (${t.route} = 'answer' AND ${t.answer} ~ '[^[:space:]]' AND num_nonnulls(${t.routedRequirementId}, ${t.routedSuggestionId}, ${t.duplicateOf}) = 0)
        OR (${t.route} = 'duplicate' AND ${t.duplicateOf} IS NOT NULL AND num_nonnulls(${t.routedRequirementId}, ${t.routedSuggestionId}, ${t.answer}) = 0)`,
    ),
    // a new item holds no route; triage writes it
    statusRouteChk: check(
      'feedback_status_route_chk',
      sql`${t.status} <> 'new' OR ${t.route} IS NULL`,
    ),
    duplicateSelfChk: check(
      'feedback_duplicate_self_chk',
      sql`${t.duplicateOf} IS NULL OR ${t.duplicateOf} <> ${t.id}`,
    ),
    redactedChk: check(
      'feedback_redacted_chk',
      sql`${t.redactedAt} IS NULL OR (${t.body} IS NULL AND ${t.redactedBy} IS NOT NULL AND (${t.whereSeen} IS NULL OR ${t.whereSeen} = 'reporter data deleted'))`,
    ),
    agencyChk: check(
      'feedback_reporter_agency_chk',
      sql`${t.reporterAgency} IN ('human', 'agent')`,
    ),
    seqUq: uniqueIndex('feedback_project_seq_uq').on(t.projectId, t.fbSeq),
    dedupUq: uniqueIndex('feedback_project_dedup_uq')
      .on(t.projectId, t.dedupKey)
      .where(sql`dedup_key IS NOT NULL`),
    snoozeChk: check(
      'feedback_snooze_chk',
      sql`(${t.snoozedUntil} IS NULL) = (${t.snoozeReason} IS NULL) AND (${t.snoozedUntil} IS NULL OR (${t.snoozeReason} ~ '[^[:space:]]' AND ${t.status} IN ('new', 'reopened')))`,
    ),
    statusIdx: index('feedback_project_status_idx').on(t.projectId, t.status),
    duplicateIdx: index('feedback_duplicate_of_idx')
      .on(t.duplicateOf)
      .where(sql`duplicate_of IS NOT NULL`),
    violatedCriterionIdx: index('feedback_violated_criterion_idx')
      .on(t.violatedCriterionId)
      .where(sql`violated_criterion_id IS NOT NULL`),
    mockupIdx: index('feedback_mockup_idx').on(t.mockupId).where(sql`mockup_id IS NOT NULL`),
    signalIdx: index('feedback_project_signal_idx')
      .on(t.projectId, t.signalKey)
      .where(sql`signal_key IS NOT NULL`),
    signalChk: check(
      'feedback_signal_key_chk',
      sql`${t.signalKey} IS NULL OR ${t.signalKey} ~ '[^[:space:]]'`,
    ),
  }),
);

// the issues an issue route names, one or more (ISS-265): an item delivered by several issues names
// every one. The deferred trigger `feedback_route_carriers_guard` (migration 0429) holds the pairing a
// CHECK cannot reach across tables: an item routed `issue` holds at least one row here, any other none
export const feedbackRouteIssues = pgTable(
  'feedback_route_issues',
  {
    feedbackId: uuid('feedback_id')
      .notNull()
      .references(() => feedback.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id')
      .notNull()
      .references((): AnyPgColumn => issues.id, { onDelete: 'no action' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.feedbackId, t.issueId] }),
    issueIdx: index('feedback_route_issues_issue_idx').on(t.issueId),
  }),
);

// a decision is a row, not an overwrite (docs/patterns/core-module.md "Records and events"): a re-triage
// after a reopen keeps the route it replaced. Insert-only by trigger, removed only with its item
export const feedbackDecisions = pgTable(
  'feedback_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    feedbackId: uuid('feedback_id')
      .notNull()
      .references(() => feedback.id, { onDelete: 'cascade' }),
    decision: text('decision', { enum: FEEDBACK_DECISIONS }).notNull(),
    route: text('route', { enum: FEEDBACK_ROUTES }),
    /** What the route points at, by key (ISS-12, REQ-3, FB-4), as it read when decided. */
    carrier: text('carrier'),
    reason: text('reason'),
    /** Null on a decision Forge took itself (`system`), which has no person. */
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'restrict' }),
    decidedAgency: text('decided_agency', { enum: ['human', 'agent', 'system'] }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
    fromSuggestionId: uuid('from_suggestion_id').references((): AnyPgColumn => suggestions.id, {
      onDelete: 'no action',
    }),
    /** On an answer: the reopen or reply of this item it answers (REQ-47 BC-13). */
    inReplyTo: uuid('in_reply_to').references((): AnyPgColumn => feedbackDecisions.id, {
      onDelete: 'no action',
    }),
  },
  (t) => ({
    decisionChk: check(
      'feedback_decisions_decision_chk',
      sql`${t.decision} IN (${inList(FEEDBACK_DECISIONS)})`,
    ),
    routeChk: check(
      'feedback_decisions_route_chk',
      sql`(${t.decision} IN ('triaged', 'routed')) = (${t.route} IS NOT NULL)`,
    ),
    reasonChk: check(
      'feedback_decisions_reason_chk',
      sql`${t.decision} NOT IN ('declined', 'reopened', 'replied', 'snoozed') OR ${t.reason} ~ '[^[:space:]]'`,
    ),
    inReplyToChk: check(
      'feedback_decisions_in_reply_to_chk',
      sql`${t.inReplyTo} IS NULL OR (${t.decision} = 'triaged' AND ${t.route} = 'answer')`,
    ),
    agencyChk: check(
      'feedback_decisions_agency_chk',
      sql`${t.decidedAgency} IN ('human', 'agent', 'system') AND ((${t.decidedAgency} = 'system') = (${t.decidedBy} IS NULL))`,
    ),
    feedbackIdx: index('feedback_decisions_feedback_idx').on(t.feedbackId, t.decidedAt),
  }),
);

// a reporter's screenshot is reporter data (UC15): stored beside its item, flagged when the
// project's data policy is on, and removed with the bytes on a redaction
export const feedbackAttachments = pgTable(
  'feedback_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    feedbackId: uuid('feedback_id')
      .notNull()
      .references(() => feedback.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    storagePath: text('storage_path').notNull(),
    flagged: boolean('flagged').notNull(),
    /** The reporter's word that nothing personal shows: on a project that redacts, only such bytes reach a model (REQ-66 BC-7). */
    redacted: boolean('redacted').notNull().default(false),
    /** What the attacher marked it as (ISS-879): `approved_design` is a mockup a person approved. */
    label: text('label', { enum: FEEDBACK_ATTACHMENT_LABELS }),
    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    feedbackIdx: index('feedback_attachments_feedback_idx').on(t.feedbackId),
    labelChk: check(
      'feedback_attachments_label_chk',
      sql`${t.label} IS NULL OR ${t.label} IN (${inList(FEEDBACK_ATTACHMENT_LABELS)})`,
    ),
  }),
);

// a message to reporters, or an internal note: the row is what the thread shows. An internal note holds
// no recipient by CHECK, so a notice cannot have been addressed from one; the notice itself goes out
// on the `feedback.reporterTold` event, which a note never emits
export const feedbackMessages = pgTable(
  'feedback_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    feedbackId: uuid('feedback_id')
      .notNull()
      .references(() => feedback.id, { onDelete: 'cascade' }),
    audience: text('audience', { enum: FEEDBACK_MESSAGE_AUDIENCES }).notNull(),
    body: text('body').notNull(),
    recipients: uuid('recipients').array().notNull().default(sql`'{}'`),
    sentBy: uuid('sent_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    sentAgency: text('sent_agency', { enum: ['human', 'agent'] }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** The language the text was written in (`@forge/contracts/written-lang`); null where it was written before the language was stored. */
    writtenLang: text('written_lang', { enum: WRITTEN_LANGS }),
  },
  (t) => ({
    writtenLangChk: check(
      'feedback_messages_written_lang_chk',
      sql`${t.writtenLang} IS NULL OR ${t.writtenLang} IN ('en', 'vi')`,
    ),
    audienceChk: check(
      'feedback_messages_audience_chk',
      sql`${t.audience} IN (${inList(FEEDBACK_MESSAGE_AUDIENCES)})`,
    ),
    bodyChk: check('feedback_messages_body_chk', sql`${t.body} ~ '[^[:space:]]'`),
    internalChk: check(
      'feedback_messages_internal_chk',
      sql`${t.audience} <> 'internal' OR cardinality(${t.recipients}) = 0`,
    ),
    agencyChk: check('feedback_messages_agency_chk', sql`${t.sentAgency} IN ('human', 'agent')`),
    feedbackIdx: index('feedback_messages_feedback_idx').on(t.feedbackId, t.createdAt),
  }),
);

/**
 * Each time somebody reported an item through the Forge door (REQ-47): the filing itself and every
 * later report of its signal key while it was open. Each names its own reporter's account, person or
 * agent, and where it came from: the project, issue and run they were in and the client they used.
 * An item's source is its first row; its occurrences are its rows.
 */
export const feedbackOccurrences = pgTable(
  'feedback_occurrences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    feedbackId: uuid('feedback_id')
      .notNull()
      .references(() => feedback.id, { onDelete: 'cascade' }),
    reportedBy: uuid('reported_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    reporterAgency: text('reporter_agency', { enum: ['human', 'agent'] }).notNull(),
    sourceProjectId: uuid('source_project_id').references(() => projects.id, {
      onDelete: 'set null',
    }),
    sourceIssueId: uuid('source_issue_id').references((): AnyPgColumn => issues.id, {
      onDelete: 'set null',
    }),
    sourceRunId: uuid('source_run_id').references((): AnyPgColumn => pipelineRuns.id, {
      onDelete: 'set null',
    }),
    clientVersion: text('client_version'),
    /** What a repeat's reporter said, scrubbed on write as the item's own text is (REQ-66 BC-3). */
    said: text('said'),
    /** The screenshot taken with it: one of the item's attachments. */
    attachmentId: uuid('attachment_id').references((): AnyPgColumn => feedbackAttachments.id, {
      onDelete: 'set null',
    }),
    /** What this row was carried from, so a carry run twice writes it once (`agent_report:<id>`). */
    dedupKey: text('dedup_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    feedbackIdx: index('feedback_occurrences_feedback_idx').on(t.feedbackId, t.createdAt),
    reporterIdx: index('feedback_occurrences_reporter_idx').on(t.reportedBy),
    dedupUq: uniqueIndex('feedback_occurrences_dedup_uq')
      .on(t.dedupKey)
      .where(sql`dedup_key IS NOT NULL`),
    saidChk: check(
      'feedback_occurrences_said_chk',
      sql`${t.said} IS NULL OR ${t.said} ~ '[^[:space:]]'`,
    ),
    agencyChk: check(
      'feedback_occurrences_agency_chk',
      sql`${t.reporterAgency} IN ('human', 'agent')`,
    ),
  }),
);
