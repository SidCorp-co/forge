import {
  REFERENCE_KINDS,
  REFERENCE_ORIGINS,
  REFERENCE_RELEASE_OUTCOMES,
  REFERENCE_VERDICTS,
} from '@forge/contracts/references';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { feedback } from './schema-feedback.js';
import { organizations } from './schema-orgs.js';
import { projects } from './schema-projects.js';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/**
 * A source a project learns from first (ISS-1252): its own, or its org's (`project_id` null), shared by
 * every project of the org. A removed entry keeps its row (`removed_at`) and is never served again.
 * The follow columns are the last read of a followed repository: the tag last seen, so a read takes
 * only what is newer, its ETag, so an unchanged list costs no rate limit, and what the host said of it.
 */
export const referenceSources = pgTable(
  'reference_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Null for an org entry. */
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: REFERENCE_KINDS }).notNull(),
    url: text('url').notNull(),
    title: text('title').notNull(),
    why: text('why').notNull(),
    areas: text('areas').array().notNull(),
    priority: integer('priority').notNull(),
    followReleases: boolean('follow_releases').notNull().default(false),
    origin: text('origin', { enum: REFERENCE_ORIGINS }).notNull(),
    evidence: text('evidence'),
    addedBy: uuid('added_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    addedAgency: text('added_agency', { enum: ['human', 'agent'] }).notNull(),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    removedBy: uuid('removed_by').references(() => users.id, { onDelete: 'restrict' }),
    removedReason: text('removed_reason'),
    lastSeenTag: text('last_seen_tag'),
    lastReleaseAt: timestamp('last_release_at', { withTimezone: true }),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    followEtag: text('follow_etag'),
    followError: text('follow_error'),
    repoArchived: boolean('repo_archived'),
    repoPushedAt: timestamp('repo_pushed_at', { withTimezone: true }),
  },
  (t) => ({
    orgIdx: index('reference_sources_org_idx').on(t.orgId),
    projectIdx: index('reference_sources_project_idx').on(t.projectId),
    activeUrlUq: uniqueIndex('reference_sources_active_url_uq')
      .on(
        t.orgId,
        sql`COALESCE(${t.projectId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        sql`lower(${t.url})`,
      )
      .where(sql`removed_at IS NULL`),
    kindChk: check('reference_sources_kind_chk', sql`${t.kind} IN (${inList(REFERENCE_KINDS)})`),
    originChk: check(
      'reference_sources_origin_chk',
      sql`${t.origin} IN (${inList(REFERENCE_ORIGINS)}) AND ((${t.origin} = 'proposed') = (${t.evidence} IS NOT NULL))`,
    ),
    agencyChk: check('reference_sources_agency_chk', sql`${t.addedAgency} IN ('human', 'agent')`),
    areasChk: check('reference_sources_areas_chk', sql`cardinality(${t.areas}) BETWEEN 1 AND 12`),
    removedChk: check(
      'reference_sources_removed_chk',
      sql`(${t.removedAt} IS NULL) = (${t.removedBy} IS NULL) AND (${t.removedAt} IS NULL) = (${t.removedReason} IS NULL)`,
    ),
  }),
);

/**
 * A followed source's release as one project read it: an idea filed on the open item it may help, or
 * silent on the source's timeline. One row per source, project and tag, so a release is digested once.
 */
export const referenceReleases = pgTable(
  'reference_releases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => referenceSources.id, { onDelete: 'cascade' }),
    tag: text('tag').notNull(),
    name: text('name'),
    url: text('url').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    outcome: text('outcome', { enum: REFERENCE_RELEASE_OUTCOMES }).notNull(),
    /** The open item it may help, `ISS-n` or `REQ-n`, and the words both hold. */
    matchedRef: text('matched_ref'),
    matchedTerms: text('matched_terms').array(),
    feedbackId: uuid('feedback_id').references(() => feedback.id, { onDelete: 'set null' }),
    readAt: timestamp('read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectIdx: index('reference_releases_project_idx').on(t.projectId, t.sourceId, t.readAt),
    tagUq: uniqueIndex('reference_releases_tag_uq').on(t.sourceId, t.projectId, t.tag),
    outcomeChk: check(
      'reference_releases_outcome_chk',
      sql`${t.outcome} IN (${inList(REFERENCE_RELEASE_OUTCOMES)}) AND ((${t.outcome} = 'idea') = (${t.matchedRef} IS NOT NULL))`,
    ),
  }),
);

/** One use of a source by an agent or a person: what was read, taken or rejected, and why. Insert-only. */
export const referenceCitations = pgTable(
  'reference_citations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => referenceSources.id, { onDelete: 'cascade' }),
    ref: text('ref').notNull(),
    verdict: text('verdict', { enum: REFERENCE_VERDICTS }).notNull(),
    why: text('why').notNull(),
    about: text('about'),
    citedBy: uuid('cited_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    citedAgency: text('cited_agency', { enum: ['human', 'agent'] }).notNull(),
    citedAt: timestamp('cited_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectIdx: index('reference_citations_project_idx').on(t.projectId, t.sourceId, t.citedAt),
    verdictChk: check(
      'reference_citations_verdict_chk',
      sql`${t.verdict} IN (${inList(REFERENCE_VERDICTS)})`,
    ),
    agencyChk: check('reference_citations_agency_chk', sql`${t.citedAgency} IN ('human', 'agent')`),
  }),
);
