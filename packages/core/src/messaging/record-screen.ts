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
  type ForgeRecordFault,
  type ForgeRecordField,
} from './forge-record.js';
import { screenMessage } from './screen.js';

/** The rules this module owns, for the document that has to name them all. */
export const RECORD_RULE_IDS: readonly string[] = [
  'field-budget',
  'record-in-comment',
  'record-fence-shape',
];

/** The guide that holds the whole table, named by every record-in-comment message. */
export const RECORD_GUIDE_SLUG = 'records-and-comments';

/**
 * Where a record goes when it is not a comment, by the kind that names it — and ONLY where a store
 * holds the whole of that kind. `issue_step_contexts` types a verdict on `(issue, step, attempt)`;
 * nothing holds a baseline or a decision, so those go to the guide rather than to a route that
 * would refuse them UNREGISTERED_KEY. A `Map` because the kind is caller-supplied: `constructor`
 * on an object literal answers off the prototype instead of taking the unsupported-kind path.
 */
export const RECORD_DESTINATIONS: ReadonlyMap<string, string> = new Map([
  ['verdict', 'POST /api/issue-step-contexts'],
  ['review', 'POST /api/issue-step-contexts'],
]);

export const ISSUE_ASSERTION_ROUTE = 'POST /api/issues/:id/attributes';

export function destinationFor(kind: string | null): string | null {
  return kind ? (RECORD_DESTINATIONS.get(kind) ?? null) : null;
}

/** One sentence, built once, served both as the refusal and as the warning, so the two cannot drift. */
export function recordInCommentMessage(record: ForgeRecord): string {
  const route = destinationFor(record.kind);
  const named = record.kind ? `a \`${record.kind}\` record` : 'a record';
  const where = route
    ? `${named} goes to \`${route}\`, and the comment keeps your summary line`
    : `no store here holds ${named} whole — put the assertions it makes about the issue at \`${ISSUE_ASSERTION_ROUTE}\` under a registered key, and keep the sentence in the comment`;
  return `a \`forge-record\` fence is not comment content — ${where}. The store each kind belongs in: guide \`${RECORD_GUIDE_SLUG}\``;
}

const RECORD_IN_COMMENT_SHAPE =
  'a comment body carries prose for a person; a structured record is written to the store its kind names';

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

/** The same sentence as a warning, for a caller that declared nothing. */
export function recordInCommentWarning(record: ForgeRecord | null): string | null {
  return record ? recordInCommentMessage(record) : null;
}

const FENCE_SHAPE =
  'a `forge-record` block opens ```forge-record and closes with backticks alone, and names its kind either on a `forge-record: <kind> · contract <n>` line after the close or on the opening fence itself as ```forge-record: <kind> · contract <n>';

const FENCE_EXAMPLE = [
  '```forge-record: verdict · contract 1',
  'criterion: 13',
  'verdict: skipped',
  '```',
].join('\n');

/**
 * A body that opened a record fence and carries no record, told to whoever wrote it.
 */
export function recordFenceRefusal(fault: ForgeRecordFault | null): MessageRefusal | null {
  if (!fault) return null;
  return {
    rule: 'record-fence-shape',
    why: `${fault.why} — so this comment would be stored carrying no record at all, which is the one outcome that is not allowed: a body meant to carry a record either carries one or is told it does not. The shapes that are read are below, and the store each kind belongs in: guide \`${RECORD_GUIDE_SLUG}\``,
    quote: fault.quote,
    shape: FENCE_SHAPE,
    example: FENCE_EXAMPLE,
  };
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
