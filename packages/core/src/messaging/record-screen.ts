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
export const RECORD_RULE_IDS: readonly string[] = ['field-budget'];

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
