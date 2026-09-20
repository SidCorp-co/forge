import { and, eq, inArray, isNotNull, or } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { organizationMembers, projectMembers, projects, users } from '../db/schema.js';
import { ROLE_PRODUCT, ROLE_TECHNICAL } from './audiences.js';
import type { Audience, MessageRefusal, MessageVerdict } from './contract.js';

/** Which reading a project's own members are screened and drawn under. */
export type RecordLens = 'product' | 'technical';

import {
  FORGE_RECORD_FIELD_BUDGET,
  type ForgeRecord,
  type ForgeRecordField,
} from './forge-record.js';
import { screenMessage } from './screen.js';

/** The rules this module owns, for the document that has to name them all. */
export const RECORD_RULE_IDS: readonly string[] = ['field-budget', 'record-in-comment'];

/** The guide that holds the whole table, named by every record-in-comment message. */
export const RECORD_GUIDE_SLUG = 'records-and-comments';

/** Where a record goes when it is not a comment: the route, by the kind that names it. */
export const RECORD_DESTINATIONS: Readonly<Record<string, string>> = {
  verdict: 'POST /api/issue-step-contexts',
  review: 'POST /api/issue-step-contexts',
  confirmation: 'POST /api/issues/:id/attributes',
  decision: 'POST /api/issues/:id/attributes',
  baseline: 'POST /api/issues/:id/attributes',
  merged: 'POST /api/issues/:id/attributes',
  verification: 'POST /api/issues/:id/attributes',
  triage: 'POST /api/issues/:id/attributes',
  park: 'POST /api/issues/:id/attributes',
};

/**
 * The route this record's own kind goes to, or null where the table does not
 * name it. An untagged fence carries no kind and lands here too: it is sent to
 * the guide rather than guessed at, because guessing a destination is how a
 * verdict ends up in the store that holds issue assertions.
 */
export function destinationFor(kind: string | null): string | null {
  return kind ? (RECORD_DESTINATIONS[kind] ?? null) : null;
}

/**
 * One sentence, built once, served both as the refusal and as the warning —
 * so a caller told where to go and a caller refused for not going there can
 * never be told two different things.
 */
export function recordInCommentMessage(record: ForgeRecord): string {
  const route = destinationFor(record.kind);
  const named = record.kind ? `a \`${record.kind}\` record` : 'a record';
  const where = route
    ? `${named} goes to \`${route}\`, and the comment keeps your summary line`
    : `${named} goes to the record store rather than into a comment body, and the comment keeps your summary line`;
  return `a \`forge-record\` fence is not comment content — ${where}. The store each kind belongs in: guide \`${RECORD_GUIDE_SLUG}\``;
}

const RECORD_IN_COMMENT_SHAPE =
  'a comment body carries prose for a person; a structured record is written to the store its kind names';

/**
 * The fence refused by name, for a caller that declared it can write elsewhere.
 */
export function recordInCommentRefusal(record: ForgeRecord | null): MessageRefusal | null {
  if (!record) return null;
  return {
    rule: 'record-in-comment',
    why: recordInCommentMessage(record),
    quote: '```forge-record',
    shape: RECORD_IN_COMMENT_SHAPE,
    example: destinationFor(record.kind) ?? `guide \`${RECORD_GUIDE_SLUG}\``,
  };
}

/**
 * The same sentence as a warning, for a caller that declared nothing.
 *
 * It ships on the deploy the refusal is dormant on: the rule reaches the fleet
 * as guidance first and as a gate only once a caller says it can obey.
 */
export function recordInCommentWarning(record: ForgeRecord | null): string | null {
  return record ? recordInCommentMessage(record) : null;
}

const SHAPE = `every field of a \`forge-record\` block is at most ${FORGE_RECORD_FIELD_BUDGET} characters`;
const EXAMPLE = 'finding: holds';

/**
 * A field past its budget, told to whoever wrote it by name and by how much.
 */
function refusalFor(field: ForgeRecordField): MessageRefusal {
  return {
    rule: 'field-budget',
    why: `the \`${field.key}\` field is ${field.over} character(s) over its ${FORGE_RECORD_FIELD_BUDGET}-character budget — a field that has outgrown its job is not trimmed at random: say less, or move what belongs elsewhere to the field that holds it`,
    quote: field.key,
    shape: SHAPE,
    example: EXAMPLE,
  };
}

/** Every field of this record that is past the budget, in the order written. */
export function budgetRefusals(record: ForgeRecord | null): MessageRefusal[] {
  if (!record) return [];
  return record.fields.filter((f) => f.over > 0).map(refusalFor);
}

/**
 * Which reading the lead is screened under, for one project.
 */
export async function projectLens(projectId: string, executor?: Tx): Promise<RecordLens> {
  const handle = executor ?? db;
  try {
    const [project] = await handle
      .select({ orgId: projects.orgId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project?.orgId) return 'product';
    const rows = await handle
      .select({ lenses: organizationMembers.lenses, orgRole: organizationMembers.role })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .leftJoin(
        projectMembers,
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, organizationMembers.userId),
        ),
      )
      .where(
        and(
          eq(organizationMembers.orgId, project.orgId),
          eq(users.kind, 'human'),
          or(
            isNotNull(projectMembers.userId),
            inArray(organizationMembers.role, ['owner', 'admin']),
          ),
        ),
      );
    const technical = rows.some((r) => ((r.lenses ?? []) as string[]).includes('technical'));
    return technical ? 'technical' : 'product';
  } catch {
    return 'product';
  }
}

/** The cell a lens names. The one place the two vocabularies meet. */
export const audienceForLens = (lens: RecordLens): Audience =>
  lens === 'technical' ? ROLE_TECHNICAL : ROLE_PRODUCT;

/**
 * The same resolution the card is drawn under, as the audience a lead is read at.
 */
export async function projectLeadAudience(projectId: string, executor?: Tx): Promise<Audience> {
  return audienceForLens(await projectLens(projectId, executor));
}

/**
 * The lead, screened alone, against the cell the project's lens names.
 */
export function screenLead(lead: string, audience: Audience): MessageVerdict {
  return screenMessage({ audience, intent: 'report', segments: [lead] });
}

/**
 * Everything the record itself is refused for: the budget, then the lead.
 */
export async function recordRefusals(
  projectId: string,
  record: ForgeRecord | null,
  executor?: Tx,
): Promise<MessageRefusal[]> {
  if (!record) return [];
  const refusals = budgetRefusals(record);
  if (record.lead === null) return refusals;
  const verdict = screenLead(record.lead, await projectLeadAudience(projectId, executor));
  return verdict.ok ? refusals : [...refusals, ...verdict.refusals];
}
